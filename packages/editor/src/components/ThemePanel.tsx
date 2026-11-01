import { useState } from "react";
import { contrastIssues } from "@xcursus/core";
import type { FontId, ProjectDocument, Result, Theme } from "@xcursus/core";
import { editTheme } from "../commands/index.js";
import type { EditorStore } from "../store/index.js";
import { Numeric } from "./Inspector.js";
import { Icon, IconButton } from "./icons.js";

export const fontNames: Record<FontId, string> = {
  "system-sans": "System sans",
  "system-serif": "System serif",
  "system-mono": "System mono",
  "atkinson-hyperlegible": "Atkinson Hyperlegible",
};
/** Where a contrast issue lives, in the words of the panels. */
function where(document: ProjectDocument, pointer: string): string {
  if (pointer === "/theme/colors/text") return "theme text on the background";
  if (pointer === "/theme/colors/accent") return "accent on the backdrop";
  const [, , scene, , block] = pointer.split("/");
  const title = document.scenes[Number(scene)]?.title ?? "";
  return block === undefined
    ? `background of scene “${title}”`
    : `block ${Number(block) + 1} of scene “${title}”`;
}
const roles: Array<[keyof Theme["colors"], string, string]> = [
  ["text", "Text colour", "Text"],
  ["background", "Card background", "Card"],
  ["accent", "Accent and border", "Accent"],
  ["backdrop", "Backdrop", "Backdrop"],
];
/** Document theme: palette, roles, local fonts and type scale; tokens only, never CSS. */
export function ThemePanel({
  store,
  document,
}: {
  store: EditorStore;
  document: ProjectDocument;
}) {
  const [error, setError] = useState("");
  const theme = document.theme;
  const report = (result: Result<void>) => {
    setError(
      result.ok
        ? ""
        : result.diagnostics.some((d) => d.code === "UNKNOWN_PALETTE_COLOR")
          ? "The colour is still used by a role, a scene or a block."
          : (result.diagnostics[0]?.message ?? "Edit rejected."),
    );
    return result;
  };
  const issues = contrastIssues(document);
  return (
    <div className="theme-panel">
      <div className="theme-content">
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="inspector-group">
          <h3>
            Palette <span>{theme.palette.length}/32</span>
          </h3>
          <ul className="palette">
            {theme.palette.map((entry, i) => (
              <li key={entry.id}>
                <label className="swatch">
                  <input
                    type="color"
                    aria-label={`Colour ${entry.id}`}
                    value={entry.value}
                    onChange={(e) =>
                      report(
                        store.coalesce(
                          `theme:palette:${entry.id}`,
                          editTheme((t) => {
                            t.palette[i]!.value = e.target.value.toLowerCase();
                          }),
                        ),
                      )
                    }
                    onBlur={() => store.endCoalesce()}
                  />
                  <span className="swatch-name">{entry.id}</span>
                  <code>{entry.value}</code>
                </label>
                <IconButton
                  icon="close"
                  label={`Remove colour ${entry.id}`}
                  tip="left"
                  disabled={theme.palette.length === 1}
                  onClick={() =>
                    report(
                      store.execute(
                        editTheme((t) => {
                          t.palette.splice(i, 1);
                        }),
                      ),
                    )
                  }
                />
              </li>
            ))}
          </ul>
          <button
            type="button"
            tabIndex={0}
            className="tool-button"
            aria-label="Add colour"
            disabled={theme.palette.length >= 32}
            onClick={() => {
              let n = theme.palette.length + 1;
              while (theme.palette.some((p) => p.id === `colour-${n}`)) n++;
              report(
                store.execute(
                  editTheme((t) => {
                    t.palette.push({ id: `colour-${n}`, value: "#5b6474" });
                  }),
                ),
              );
            }}
          >
            <Icon name="plus" />
            Colour
          </button>
        </div>
        <div className="inspector-group">
          <h3>Roles</h3>
          <div className="prop-grid two">
            {roles.map(([role, label, short]) => (
              <label key={role} className="prop">
                <span>{short}</span>
                <select
                  aria-label={label}
                  value={theme.colors[role]}
                  onChange={(e) =>
                    report(
                      store.execute(
                        editTheme((t) => {
                          t.colors[role] = e.target.value;
                        }),
                      ),
                    )
                  }
                >
                  {theme.palette.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.id}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </div>
        <div className="inspector-group">
          <h3>
            Typography <span>local fonts · px</span>
          </h3>
          <div className="prop-grid two">
            {(
              [
                ["body", "Body font", "Text"],
                ["heading", "Heading font", "Headings"],
              ] as const
            ).map(([slot, label, short]) => (
              <label key={slot} className="prop">
                <span>{short}</span>
                <select
                  aria-label={label}
                  value={theme.fonts[slot]}
                  onChange={(e) =>
                    report(
                      store.execute(
                        editTheme((t) => {
                          t.fonts[slot] = e.target.value as FontId;
                        }),
                      ),
                    )
                  }
                >
                  {(Object.keys(fontNames) as FontId[]).map((id) => (
                    <option key={id} value={id}>
                      {fontNames[id]}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <Numeric
              label="Body text size"
              short="Body"
              value={theme.typeScale.body}
              apply={(value) =>
                report(
                  store.execute(
                    editTheme((t) => {
                      t.typeScale.body = value;
                    }),
                  ),
                )
              }
            />
            <Numeric
              label="Headings"
              value={theme.typeScale.title}
              apply={(value) =>
                report(
                  store.execute(
                    editTheme((t) => {
                      t.typeScale.title = value;
                    }),
                  ),
                )
              }
            />
          </div>
        </div>
        <section className="inspector-group" aria-label="Theme contrast">
          <h3>Contrast</h3>
          {issues.length ? (
            <ul className="contrast-list">
              {issues.map((issue) => (
                <li key={issue.pointer}>
                  <Icon name="warning" />
                  <span>
                    {issue.ratio.toFixed(2)}:1, below {issue.minimum}:1 (
                    {issue.kind === "text" ? "text" : "components"}):{" "}
                    {where(document, issue.pointer)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="panel-note">
              Sufficient: 4.5:1 for text, 3:1 for components.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
