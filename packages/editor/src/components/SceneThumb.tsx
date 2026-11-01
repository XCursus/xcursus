import type { ProjectDocument, Scene } from "@xcursus/core";

/**
 * Schematic thumbnail of a scene drawn from the document alone: theme colors,
 * appearance and block frames. No player instance, so it stays cheap for
 * long scene lists. Decorative: the scene title is the accessible name.
 */
export function SceneThumb({
  document,
  scene,
}: {
  document: ProjectDocument;
  scene: Scene;
}) {
  const { theme } = document;
  const color = (id: string | null | undefined, fallback: string) =>
    theme.palette.find((p) => p.id === id)?.value ?? fallback;
  const [width, height] = scene.size;
  const ink = color(theme.colors.text, "#172035"),
    accent = color(theme.colors.accent, "#215baf"),
    card = color(
      scene.appearance.background ?? theme.colors.background,
      "#fff",
    ),
    plain = scene.appearance.variant === "plain";
  const pad = width * 0.08,
    bar = Math.max(height * 0.05, 6);
  return (
    <svg
      className="scene-thumb"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
      style={{ background: color(theme.colors.backdrop, "#e8edf4") }}
    >
      <rect
        width={width}
        height={height}
        fill={plain && !scene.appearance.background ? "transparent" : card}
        stroke={plain ? "none" : accent}
        strokeWidth={plain ? 0 : width * 0.012}
      />
      {scene.layout === "canvas"
        ? [...scene.blocks]
            .filter((b) => b.frame)
            .sort((a, b) => a.frame!.z - b.frame!.z)
            .map((b) => {
              const f = b.frame!;
              const media = ["image", "svg", "video", "embed"].includes(b.type);
              return (
                <rect
                  key={b.id}
                  x={f.x}
                  y={f.y}
                  width={f.width}
                  height={f.height}
                  rx={Math.min(f.width, f.height) * 0.04}
                  transform={`rotate(${f.rotation} ${f.x} ${f.y})`}
                  fill={media ? accent : ink}
                  opacity={media ? 0.45 : 0.22}
                />
              );
            })
        : [
            ...(scene.appearance.titleVisible ? [0.55] : []),
            ...scene.blocks.slice(0, 5).map(() => 0.8),
          ].map((share, i) => (
            <rect
              key={i}
              x={pad}
              y={pad + i * bar * 2.2}
              width={(width - pad * 2) * share}
              height={bar}
              rx={bar / 2}
              fill={ink}
              opacity={i === 0 && scene.appearance.titleVisible ? 0.5 : 0.22}
            />
          ))}
    </svg>
  );
}
