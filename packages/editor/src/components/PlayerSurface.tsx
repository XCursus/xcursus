import { useEffect, useRef } from "react";
import { createPlayer, createAssetResolver } from "@xcursus/player";
import type { Player } from "@xcursus/player";
import type { AssetBlobs } from "@xcursus/player";
import { createBuiltinRegistry } from "@xcursus/plugins/builtins";
import type { PluginDefinition } from "@xcursus/plugins";
import {
  sampleTransition,
  resolveSceneCamera,
  cameraPose,
  success,
} from "@xcursus/core";
import type { Capture } from "./CameraTimeline.js";
import type { NavigationSelection } from "./PathPanel.js";
import type { ProjectDocument } from "@xcursus/core";
export function PlayerSurface({
  document,
  selection,
  present = false,
  onPlayer,
  navigation = null,
  capture = null,
  blobs,
  layout = false,
  onHost,
  plugins = [],
}: {
  document: ProjectDocument;
  selection: string | null;
  present?: boolean;
  navigation?: NavigationSelection | null;
  capture?: Capture | null;
  onPlayer?: (player: Player | null, present: boolean) => void;
  blobs?: AssetBlobs;
  /** Scene editor: the selected scene is always framed frontally with resolveSceneCamera. */
  layout?: boolean;
  onHost?: (host: HTMLDivElement | null) => void;
  /** Host-approved plugins; the builtins no longer include the demo badge. */
  plugins?: readonly PluginDefinition[];
}) {
  const host = useRef<HTMLDivElement>(null),
    player = useRef<Player | null>(null);
  const initial = useRef(document),
    callback = useRef(onPlayer),
    approved = useRef(plugins),
    hostCallback = useRef(onHost);
  callback.current = onPlayer;
  hostCallback.current = onHost;
  const assets = useRef(
    createAssetResolver(document.assets, blobs ?? new Map()),
  );
  assets.current = createAssetResolver(document.assets, blobs ?? new Map());
  useEffect(() => {
    const builtins = createBuiltinRegistry({ plugins: approved.current });
    const instance = createPlayer({
      // Studio's interface is Italian until 1.0 (G0 decision 3).
      input: present,
      motion: present ? "system" : "reduced",
      registry: builtins.registry,
      assets: {
        resolve: (id, signal) => assets.current.resolve(id, signal),
        revision: (id) => assets.current.revision?.(id),
      },
      muted: !present,
    });
    player.current = instance;
    void instance.mount(host.current!, initial.current).then((result) => {
      if (!result.ok)
        host.current!.textContent = result.diagnostics
          .map((d) => d.message)
          .join("; ");
    });
    callback.current?.(instance, present);
    hostCallback.current?.(host.current);
    return () => {
      hostCallback.current?.(null);
      callback.current?.(null, present);
      instance.destroy();
      builtins.plugins.destroy();
      player.current = null;
    };
  }, [present]);
  useEffect(() => {
    if (present) return;
    const frame = requestAnimationFrame(() => {
      const instance = player.current;
      if (!instance) return;
      void instance.updateDocument(document).then((result) => {
        if (!result.ok) return;
        const path = document.paths.find(
            (p) => p.id === (navigation?.pathId ?? document.defaultPathId),
          ),
          node = navigation
            ? path?.nodes.find((n) => n.id === navigation.nodeId)
            : path?.nodes.find((n) => n.sceneId === selection);
        if (path && node)
          void instance
            .goTo({ pathId: path.id, nodeId: node.id }, { durationMs: 0 })
            .then(() => {
              const pose =
                node.camera && !layout
                  ? success(cameraPose(node.camera))
                  : resolveSceneCamera(document, node.sceneId);
              if (pose.ok) instance.setCamera(pose.value);
            });
        else if (selection) {
          const pose = resolveSceneCamera(document, selection);
          if (pose.ok) instance.setCamera(pose.value);
        }
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [document, selection, present, navigation, blobs, layout]);
  useEffect(() => {
    if (!present && !layout) {
      if (capture)
        player.current?.setCamera(
          sampleTransition(capture.plan, capture.elapsedMs).camera,
        );
      else player.current?.setView("scene");
    }
  }, [capture, present, layout]);
  return (
    <div
      ref={host}
      className={present ? "presentation-player" : "preview-player"}
      aria-label={present ? "Presentation player" : "Preview player"}
    />
  );
}
