import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { getWorldMatrix, isSceneVisible } from "@xcursus/core";
import type { EditorSession, EditorStore } from "../store/index.js";
import { Icon } from "./icons.js";
/** Text that fits a width measured in average characters, with an ellipsis. */
const fit = (text: string, chars: number) =>
  chars < 3 ? "" : text.length > chars ? `${text.slice(0, chars - 1)}…` : text;
export function MapView({
  store,
  session,
}: {
  store: EditorStore;
  session: EditorSession;
}) {
  const gesture = useRef<{
    pointer: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
    scene: boolean;
  } | null>(null);
  const { map, document } = session;
  // Screen pixels per map unit of the fixed viewBox: labels keep a constant
  // on-screen size whatever the panel's size and the zoom.
  const svg = useRef<SVGSVGElement>(null),
    [unit, setUnit] = useState(1);
  useEffect(() => {
    const element = svg.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const { width, height } = element.getBoundingClientRect();
      if (width && height) setUnit(Math.min(width / 1200, height / 800));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const label = 11 / (unit * map.zoom);
  function down(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.button !== 0 || gesture.current) return;
    const id = (event.target as Element)
      .closest("[data-map-scene]")
      ?.getAttribute("data-map-scene");
    const scene = document.scenes.find((s) => s.id === id);
    if (scene) store.beginDrag(scene.id);
    const world = scene ? getWorldMatrix(document, scene.id) : null;
    gesture.current = {
      pointer: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: world?.ok ? world.value[12]! : map.x,
      y: world?.ok ? world.value[13]! : map.y,
      scene: !!scene,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
  }
  function finish(cancel = false) {
    if (!gesture.current) return;
    if (gesture.current.scene) {
      if (cancel) store.cancelDrag();
      else store.endDrag();
    } else if (cancel)
      store.setMap({ ...map, x: gesture.current.x, y: gesture.current.y });
    gesture.current = null;
  }
  return (
    <section className="map-panel" aria-label="XY map">
      <div className="panel-heading">
        <h2>
          Spatial map <span>XY</span>
        </h2>
        <div className="map-tools">
          <button
            type="button"
            tabIndex={0}
            className="icon-button"
            aria-label="Zoom out"
            onClick={() =>
              store.setMap({ ...map, zoom: Math.max(0.02, map.zoom / 1.25) })
            }
          >
            <Icon name="zoom-out" />
          </button>
          <output aria-label="Map zoom">{Math.round(map.zoom * 100)}%</output>
          <button
            type="button"
            tabIndex={0}
            className="icon-button"
            aria-label="Zoom in"
            onClick={() =>
              store.setMap({ ...map, zoom: Math.min(2, map.zoom * 1.25) })
            }
          >
            <Icon name="plus" />
          </button>
          <button
            type="button"
            tabIndex={0}
            className="tool-button quiet"
            onClick={() => store.setMap({ x: 0, y: 0, zoom: 0.25 })}
          >
            Centre
          </button>
        </div>
      </div>
      <svg
        ref={svg}
        role="application"
        aria-label="XY map: drag the scenes; drag the background to pan the map. Escape cancels."
        tabIndex={0}
        viewBox="-600 -400 1200 800"
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={down}
        onPointerMove={(event) => {
          const g = gesture.current;
          if (!g || g.pointer !== event.pointerId) return;
          const svg = event.currentTarget;
          const matrix = svg.getScreenCTM();
          if (!matrix) return;
          const dx = (event.clientX - g.startX) / matrix.a,
            dy = (event.clientY - g.startY) / matrix.d;
          if (g.scene)
            store.moveWorldDrag(g.x + dx / map.zoom, g.y + dy / map.zoom);
          else store.setMap({ ...map, x: g.x + dx, y: g.y + dy });
        }}
        onPointerUp={() => finish()}
        onPointerCancel={() => finish(true)}
        onLostPointerCapture={() => finish(true)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            finish(true);
          } else if (
            ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
              event.key,
            )
          ) {
            event.preventDefault();
            store.setMap({
              ...map,
              x:
                map.x +
                (event.key === "ArrowLeft"
                  ? 40
                  : event.key === "ArrowRight"
                    ? -40
                    : 0),
              y:
                map.y +
                (event.key === "ArrowUp"
                  ? 40
                  : event.key === "ArrowDown"
                    ? -40
                    : 0),
            });
          }
        }}
        onWheel={(event) => {
          if (event.ctrlKey || event.metaKey) return;
          store.setMap({
            ...map,
            zoom: Math.max(
              0.02,
              Math.min(2, map.zoom * Math.exp(-event.deltaY * 0.001)),
            ),
          });
        }}
      >
        <defs>
          <pattern
            id="map-grid"
            width="40"
            height="40"
            patternUnits="userSpaceOnUse"
          >
            <circle cx="20" cy="20" r="1.6" fill="currentColor" />
          </pattern>
        </defs>
        {/* Beyond the viewBox too: the grid fills panels of any proportion. */}
        <rect
          x="-12000"
          y="-8000"
          width="24000"
          height="16000"
          fill="url(#map-grid)"
          className="map-grid"
        />
        <g transform={`translate(${map.x} ${map.y}) scale(${map.zoom})`}>
          <path
            d="M -1000000 0 H 1000000 M 0 -1000000 V 1000000"
            className="map-axis"
          />
          {document.scenes.map((scene, index) => {
            const world = getWorldMatrix(document, scene.id);
            if (!world.ok) return null;
            const m = world.value;
            // Label size in the scene's own units, after its world scale.
            const size = label / (Math.hypot(m[0]!, m[1]!) || 1);
            return (
              <g
                key={scene.id}
                data-map-scene={scene.id}
                className={`map-scene ${session.selection === scene.id ? "selected" : ""}`}
                transform={`matrix(${m[0]} ${m[1]} ${m[4]} ${m[5]} ${m[12]} ${m[13]})`}
                opacity={isSceneVisible(document, scene.id) ? 1 : 0.4}
              >
                <rect
                  x={-scene.size[0] / 2}
                  y={-scene.size[1] / 2}
                  width={scene.size[0]}
                  height={scene.size[1]}
                  rx="12"
                />
                <text
                  x={-scene.size[0] / 2 + size * 0.7}
                  y={-scene.size[1] / 2 + size * 1.5}
                  fontSize={size}
                >
                  {fit(
                    `${index + 1} · ${scene.title}`,
                    scene.size[0] / (size * 0.56) - 2,
                  )}
                </text>
                <title>
                  {scene.title} · X {scene.position[0]}, Y {scene.position[1]},
                  Z {scene.position[2]}
                </title>
              </g>
            );
          })}
        </g>
        {!document.scenes.length && (
          <text
            x="0"
            y="0"
            textAnchor="middle"
            fontSize={13 / unit}
            className="map-empty"
          >
            Create a scene to get started.
          </text>
        )}
      </svg>
      <p className="map-help" aria-hidden="true">
        Drag to move · Wheel to zoom · Esc cancels
      </p>
    </section>
  );
}
