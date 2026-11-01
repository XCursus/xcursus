import { useState } from "react";
import { failure, success } from "@xcursus/core";
import type { Block, Scene, JsonValue } from "@xcursus/core";
import { defaultFrame, editScene, randomId } from "../commands/index.js";
import type { EditorStore } from "../store/index.js";
import { TextField } from "./Inspector.js";
import { Icon, IconButton } from "./icons.js";
import { blockTypes } from "./blockTypes.js";
import {
  SAMPLE_PLUGIN_ID,
  SAMPLE_PLUGIN_IDS,
  sampleInspector,
} from "@xcursus/plugins/sample";
export function ContentPanel({
  store,
  scene,
}: {
  store: EditorStore;
  scene: Scene;
}) {
  const [type, setType] = useState<Block["type"]>("markdown"),
    [error, setError] = useState("");
  const edit = (blocks: Block[]) =>
    store.execute(editScene(scene.id, { blocks }));
  /** Text edits of one block field coalesce into one undo command per session. */
  const write = (block: Block, field: string, data: unknown) =>
    store.coalesce(
      `block:${scene.id}:${block.id}:${field}`,
      editScene(scene.id, {
        blocks: scene.blocks.map((b) =>
          b.id === block.id ? ({ ...b, data } as Block) : b,
        ),
      }),
    );
  const end = () => store.endCoalesce();
  function add(kind: Block["type"]) {
    const doc = store.getSnapshot().document;
    const asset = doc.assets.find((a) => a.mime.startsWith(kind + "/")),
      path = doc.paths.find((p) => p.nodes.length);
    if (["image", "audio", "video"].includes(kind) && !asset) {
      setError(`First add a ${kind} resource in the Resources panel.`);
      return;
    }
    const defaults: Record<Block["type"], unknown> = {
      text: { text: "New text" },
      markdown: { source: "**New Markdown**" },
      html: { source: "<p>New HTML</p>" },
      svg: {
        source:
          '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#215baf"/></svg>',
        alt: "Blue circle",
      },
      latex: {
        source: "E=mc^2",
        display: true,
        alt: "E equals m c squared",
      },
      image: {
        assetId: asset?.id,
        alt: "Image description",
        fit: "contain",
      },
      audio: {
        assetId: asset?.id,
        label: "Local audio",
        autoplay: false,
        loop: false,
        onExit: "pause",
      },
      video: {
        assetId: asset?.id,
        label: "Local video",
        alt: "Video description",
        autoplay: false,
        loop: false,
        onExit: "pause",
      },
      link: {
        label: "Go to the scene",
        target: { pathId: path?.id, nodeId: path?.nodes[0]?.id },
      },
      embed: { url: "https://example.invalid/", title: "External content" },
      plugin: {
        pluginId: SAMPLE_PLUGIN_ID,
        apiVersion: "1.0.0",
        dataVersion: "1.0.0",
        payload: { label: "Local plugin" },
      },
    };
    const result = edit([
      ...scene.blocks,
      {
        id: randomId(),
        type: kind,
        data: defaults[kind],
        // A canvas scene requires a frame for every block.
        ...(scene.layout === "canvas" ? { frame: defaultFrame(scene) } : {}),
      } as Block,
    ]);
    setError(
      result.ok ? "" : result.diagnostics.map((d) => d.message).join("; "),
    );
  }
  return (
    <fieldset className="content-panel">
      <legend>
        Blocks <span>reading order</span>
      </legend>
      {scene.blocks.map((block, i) => (
        <fieldset key={`${scene.id}-${block.id}`} className="block-editor">
          <legend>
            <span className="block-index">{i + 1}</span>
            <Icon name={blockTypes[block.type].icon} />
            {blockTypes[block.type].label}
          </legend>
          {block.type === "text" ? (
            <TextField
              label={`Text ${i + 1}`}
              short=""
              value={block.data.text}
              multiline
              apply={(text) => write(block, "text", { text })}
              onEnd={end}
            />
          ) : (
            <>
              {"source" in block.data && (
                <TextField
                  label={`Source ${block.type} ${i + 1}`}
                  short="Source"
                  value={block.data.source}
                  multiline
                  code={block.type !== "markdown"}
                  apply={(source) =>
                    write(block, "source", { ...block.data, source })
                  }
                  onEnd={end}
                />
              )}
              {block.type === "plugin" &&
                SAMPLE_PLUGIN_IDS.includes(block.data.pluginId) &&
                !!block.data.payload &&
                typeof block.data.payload === "object" &&
                !Array.isArray(block.data.payload) &&
                typeof block.data.payload.label === "string" && (
                  <TextField
                    label={`Plugin label ${i + 1}`}
                    value={block.data.payload.label}
                    apply={(value) => {
                      try {
                        return write(block, "plugin-label", {
                          ...block.data,
                          payload: sampleInspector.edit(
                            block.data.payload,
                            "label",
                            value,
                          ),
                        });
                      } catch (e) {
                        return failure("PLUGIN_DATA", String(e));
                      }
                    }}
                    onEnd={end}
                  />
                )}
              <details>
                <summary>{block.type} data</summary>
                <TextField
                  label={`Data ${block.type} ${i + 1}`}
                  short="Block JSON"
                  value={JSON.stringify(block.data, null, 2)}
                  multiline
                  code
                  apply={(text) => {
                    try {
                      return write(
                        block,
                        "data",
                        JSON.parse(text) as JsonValue,
                      );
                    } catch {
                      return failure("CONTENT_JSON", "Invalid block JSON.");
                    }
                  }}
                  onEnd={end}
                />
              </details>
            </>
          )}
          <div className="block-actions">
            <IconButton
              icon="up"
              label={`Move up block ${i + 1}`}
              tip="left"
              disabled={i === 0}
              onClick={() => {
                const blocks = [...scene.blocks];
                [blocks[i - 1], blocks[i]] = [blocks[i]!, blocks[i - 1]!];
                edit(blocks);
              }}
            />
            <IconButton
              icon="down"
              label={`Move down block ${i + 1}`}
              tip="left"
              disabled={i === scene.blocks.length - 1}
              onClick={() => {
                const blocks = [...scene.blocks];
                [blocks[i + 1], blocks[i]] = [blocks[i]!, blocks[i + 1]!];
                edit(blocks);
              }}
            />
            <IconButton
              icon="trash"
              label={`Delete block ${i + 1}`}
              tip="left"
              onClick={() =>
                edit(scene.blocks.filter((b) => b.id !== block.id))
              }
            />
          </div>
        </fieldset>
      ))}
      <div className="content-add">
        <button
          type="button"
          tabIndex={0}
          className="tool-button"
          aria-label="Add text"
          onClick={() => add("text")}
        >
          <Icon name="plus" />
          Text
        </button>
        <select
          aria-label="Block type"
          value={type}
          onChange={(e) => {
            setType(e.target.value as Block["type"]);
            setError("");
          }}
        >
          {(
            [
              "markdown",
              "html",
              "svg",
              "latex",
              "image",
              "audio",
              "video",
              "link",
              "embed",
              "plugin",
            ] as const
          ).map((t) => (
            <option key={t} value={t}>
              {blockTypes[t].label}
            </option>
          ))}
        </select>
        <button
          type="button"
          tabIndex={0}
          className="tool-button"
          aria-label="Add block"
          onClick={() => add(type)}
        >
          <Icon name="plus" />
          Add
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      <details className="plugin-settings">
        <summary>Document plugin settings</summary>
        <TextField
          label="Document plugin settings"
          short="JSON"
          value={JSON.stringify(
            store.getSnapshot().document.pluginSettings ?? {},
            null,
            2,
          )}
          multiline
          code
          apply={(text) => {
            try {
              const data = JSON.parse(text);
              return store.execute((doc) => {
                doc.pluginSettings = data;
                return success(doc);
              });
            } catch {
              return failure("PLUGIN_SETTINGS", "Invalid settings JSON.");
            }
          }}
        />
      </details>
    </fieldset>
  );
}
