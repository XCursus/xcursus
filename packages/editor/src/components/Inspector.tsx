import { useEffect, useState, useId } from "react";
import type { Scene, Result } from "@xcursus/core";
import { ContentPanel } from "./ContentPanel.js";
import { editScene } from "../commands/index.js";
import { parseFinite } from "../store/index.js";
import type { EditorStore } from "../store/index.js";
export function Numeric({
  label,
  value,
  apply,
  short,
}: {
  label: string;
  value: number;
  apply: (value: number) => Result<void>;
  /** Visible abbreviation; the accessible name stays the full label. */
  short?: string;
}) {
  const [draft, setDraft] = useState(String(value)),
    [error, setError] = useState("");
  useEffect(() => {
    setDraft(String(value));
    setError("");
  }, [value]);
  const fieldId = useId();
  function commit() {
    const parsed = parseFinite(draft);
    const result = parsed.ok ? apply(parsed.value) : parsed;
    setError(
      result.ok ? "" : (result.diagnostics[0]?.message ?? "Invalid value."),
    );
  }
  return (
    <label className="numeric" htmlFor={fieldId}>
      <span className="numeric-label">{short ?? label}</span>
      <input
        aria-label={label}
        id={fieldId}
        type="text"
        inputMode="decimal"
        value={draft}
        aria-invalid={!!error}
        aria-describedby={error ? `${fieldId}-error` : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Tab") commit();
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
          if (e.key === "Escape") {
            setDraft(String(value));
            setError("");
          }
        }}
      />
      {error && (
        <span className="field-error" id={`${fieldId}-error`}>
          {error}
        </span>
      )}
    </label>
  );
}
export function TextField({
  label,
  value,
  apply,
  multiline = false,
  code = false,
  short,
  onEnd,
}: {
  label: string;
  value: string;
  apply: (value: string) => Result<void>;
  multiline?: boolean;
  /** Source or JSON: monospaced. Prose stays in the interface font. */
  code?: boolean;
  /** Visible label; the accessible name stays the full label. */
  short?: string;
  /** Called when the editing session ends (blur), after the last commit. */
  onEnd?: () => void;
}) {
  const fieldId = useId();
  const [draft, setDraft] = useState(value),
    [error, setError] = useState("");
  useEffect(() => {
    setDraft(value);
    setError("");
  }, [value]);
  function commit() {
    const result = apply(draft);
    setError(
      result.ok ? "" : (result.diagnostics[0]?.message ?? "Invalid value."),
    );
  }
  const props = {
    "aria-label": label,
    value: draft,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDraft(e.target.value),
    onBlur: () => {
      commit();
      onEnd?.();
    },
    onKeyDown: (
      event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => {
      if (event.key === "Tab" || (!multiline && event.key === "Enter"))
        commit();
    },
    "aria-invalid": !!error,
    "aria-describedby": error ? `${fieldId}-error` : undefined,
  };
  return (
    <label className={`text-field ${code ? "code" : ""}`}>
      {short ?? label}
      {multiline ? <textarea {...props} rows={4} /> : <input {...props} />}{" "}
      {error && (
        <span className="field-error" id={`${fieldId}-error`}>
          {error}
        </span>
      )}
    </label>
  );
}
/** One labelled row of compact fields (X Y Z): the row label names the group. */
export function PropRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="prop-row" role="group" aria-labelledby={id}>
      <span className="row-label" id={id}>
        {label}
      </span>
      {children}
    </div>
  );
}
export function Inspector({
  store,
  scene,
}: {
  store: EditorStore;
  scene: Scene | undefined;
}) {
  if (!scene)
    return (
      <p className="empty-inspector">
        Select a scene to edit its space and blocks.
      </p>
    );
  const edit = (patch: Partial<Scene>) =>
    store.execute(editScene(scene.id, patch));
  // Text fields: one undo command per editing session of the field.
  const text = (field: "title" | "notes") => (value: string) =>
    store.coalesce(
      `scene:${scene.id}:${field}`,
      editScene(scene.id, { [field]: value }),
    );
  const end = () => store.endCoalesce();
  return (
    <div className="inspector-content">
      <div className="inspector-group">
        <h3>
          Scene{" "}
          <span className="chip">
            {scene.layout === "canvas" ? "Canvas" : "Flow"}
          </span>
        </h3>
        <TextField
          key={`title-${scene.id}`}
          label="Scene title"
          short="Title"
          value={scene.title}
          apply={text("title")}
          onEnd={end}
        />
      </div>
      <fieldset className="inline-fields">
        <legend>
          Transform <span>px · ° Rz Ry Rx</span>
        </legend>
        <PropRow label="Position">
          {["X", "Y", "Z"].map((axis, i) => (
            <Numeric
              key={`${scene.id}-p${i}`}
              label={axis}
              value={scene.position[i]!}
              apply={(value) => {
                const position: [number, number, number] = [...scene.position];
                position[i] = value;
                return edit({ position });
              }}
            />
          ))}
        </PropRow>
        <PropRow label="Rotation">
          {["Rotation X", "Rotation Y", "Rotation Z"].map((axis, i) => (
            <Numeric
              key={`${scene.id}-r${i}`}
              label={axis}
              short={axis.slice(-1)}
              value={scene.rotation[i]!}
              apply={(value) => {
                const rotation: [number, number, number] = [...scene.rotation];
                rotation[i] = value;
                return edit({ rotation });
              }}
            />
          ))}
        </PropRow>
        <PropRow label="Size">
          {["Width", "Height"].map((axis, i) => (
            <Numeric
              key={`${scene.id}-s${i}`}
              label={axis}
              short={i ? "H" : "W"}
              value={scene.size[i]!}
              apply={(value) => {
                const size: [number, number] = [...scene.size];
                size[i] = value;
                return edit({ size });
              }}
            />
          ))}
          <Numeric
            key={`${scene.id}-scale`}
            label="Scale"
            short="×"
            value={scene.scale}
            apply={(scale) => edit({ scale })}
          />
        </PropRow>
      </fieldset>
      <ContentPanel store={store} scene={scene} />
      <TextField
        key={`${scene.id}-notes`}
        label="Speaker notes"
        value={scene.notes}
        multiline
        apply={text("notes")}
        onEnd={end}
      />
    </div>
  );
}
