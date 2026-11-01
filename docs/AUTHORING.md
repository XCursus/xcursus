# Using XCursus Studio

XCursus Studio is the visual editor of XCursus. It runs entirely in the browser, with no account or backend, and previews every change with the same player used for presenting and exporting.

Run `pnpm dev:studio` from the repository root after the installation described in the [README](../README.md#install-and-run), then open the address printed by Vite, usually `http://127.0.0.1:5174`. A production build (`pnpm build`, then `apps/studio/dist`) can be served from any static host and works offline after the first load.

## Scenes and space

The top bar holds the project title (editable in place) and the document commands as icons, each with a description shown on hover and on keyboard focus: New, Open, Save JSON, Save archive, Undo, Redo, Recovery and Preview; **Presenter** and **Present** are text buttons. Every icon has an accessible name equal to its description. The Studio interface is dark; scenes and the player keep the document's colours. The preview sits above, the map below; the scene list shows a schematic thumbnail drawn from the document.

Use **New scene** (the + icon in the header of the Scenes panel, or **Create the first scene** in an empty project) to start. The scene is inserted after the selected one; **Duplicate scene** creates a copy with new identities. The list on the left and the main path keep the same order. Select a scene in the list or drag it on the XY map. Drag the background to pan the map; the wheel, the +/− buttons and Centre control the view. These controls do not change the document.

The inspector edits X, Y and Z in CSS pixels, rotations in degrees, a positive uniform scale and the size. X points right, Y down, Z towards the viewer; the pivot is at the centre and the rotation is Rz × Ry × Rx. Confirm a number with Enter, Tab or by leaving the field. Non-finite numbers, a zero scale and out-of-range values show an error attached to the field and are not applied.

The preview uses the real player and frames the selected scene. Rotations come out aligned to the camera, as in the presentation; the map shows the XY projection of the rectangle. **Text** holds plain text, even when you type HTML tags: they are never executed. **Speaker notes** are saved but never appear in the audience player.

## Undo and references

**Undo** and **Redo** cover creation, duplication, deletion and the inspector. A complete drag counts as one command; Escape during the drag restores the original position. A typing session in a text field (project title, scene title, notes, text, block sources and data) counts as one command: from the moment you enter the field until you leave it, Undo restores the previous text in a single step. An edit after Undo discards the Redo history. The history keeps up to 100 commands and 20 MiB of snapshots; the oldest are evicted. It is not saved in the JSON.

**Delete scene** asks for confirmation and stitches the main path back together; Undo also restores the original transitions and IDs. If other paths reference the scene, Studio states the impact and refuses the deletion. Imported documents whose main path differs from the scene order, or that repeat visits, still open and remain editable in their blocks and transforms; structural edits are refused to preserve their references.

## Files and recovery

Studio saves two kinds of file, described in detail in [Project files and the `.xcursus` format](FILE_FORMAT.md):

- **Save JSON** downloads `<title>.json`, the document alone, in the current schema 1.3.0: texts, blocks, notes, parents, paths, camera, tracks and cues, layout, theme and opaque extensions. Assets stay as references to files next to it.
- **Save archive** downloads `<title>.xcursus`, the portable native format: the same document with every asset and a digest manifest in one file.

**Open** (Ctrl/Cmd+O) reads a JSON file, a `.xcursus` archive or a legacy `.spatialdeck` archive saved by SpatialDeck, the former name of XCursus, as an in-memory copy. It validates the candidate first; invalid JSON leaves your work untouched. If there are unsaved changes, you can cancel the replacement. A historical 1.0.0, 1.1.0 or 1.2.0 file is validated and migrated in memory, with identical rendering; Save JSON downloads a new 1.3.0 copy. No operation ever writes to the opened file on disk. A legacy `.spatialdeck` archive opens with a notice: its content is imported unchanged and **Save archive** writes it as `.xcursus`; the original file is left as it was.

The local autosave writes to IndexedDB after 750 ms and keeps the last ten revisions per project. On reload it offers recovery, with title, revision, date and scene count, only if the latest revision holds changes not saved to a file: after **Save JSON** or **Save archive** it is no longer offered. The **Recovery** button always lets you pick an earlier revision too. Save the result as JSON to keep it outside the browser.

In the **Recovery** dialog, **Delete revision** removes the selected revision and **Delete local project** removes every revision of the project and the resources no longer in use. Both ask for confirmation; the open document and files already saved do not change.

Autosave **is not a backup**: clearing browser data or changing origin or port can make the revisions unavailable. Denied storage, an exceeded quota and concurrent revisions from two tabs produce a warning; the active document stays in memory and Save JSON remains available. The conflicting tab must save a copy of its own work; there is no collaborative sync. If a tab running an older Studio version blocks local storage, a warning asks you to close it and autosave resumes on its own; if another tab runs a newer version, autosave stays suspended with a warning until reload, without losing the work in memory.

## Keyboard, small screens and presenting

Every button and field is reachable with Tab; activate it with Enter or Space. The Scenes panel collapses from its title; the inspector is split into the **Scene**, **Paths** and **Theme** tabs (left and right arrows move between them). On desktop the side panels scroll independently. Numeric coordinates are a complete alternative to dragging. With focus on the map, the arrows pan the view and Escape cancels the gesture.

- Ctrl/Cmd+S: save JSON, including the text of the active field.
- Ctrl/Cmd+O: open the file picker.
- Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z: undo and redo outside text fields.
- Delete/Backspace outside fields: confirm deletion of the selected scene.
- **Present**: opens an instance of the same player and requests browser full screen (if the browser refuses, the presentation stays in the tab); arrows, Page Up, Page Down and Space navigate while the player has focus. Escape or **Back to the editor** restore focus, leave full screen and keep the model. The controls (Back to the editor, previous and next scene, and the player controls) float above the scene and fade when the pointer rests; keyboard focus keeps them visible.

The system preference for reduced motion is honoured. Text view and Reduce motion are available in the player. Tablets and phones keep files, scenes, inspector and presenting; the precision map is designed mainly for desktop. Automated checks at 768, 390 and 320 px are not equivalent to testing on physical devices.

## Hierarchy, paths and camera

Open **Spatial hierarchy**, select the scene and choose **Scene parent**. The rectangle stays in the same world position; the inspector coordinates become relative to the new parent. Descendants cannot be chosen as parent. Missing references, cycles, depth beyond 32 and out-of-range decompositions are not applied. Dragging a child also acts on the world XY plane.

Open the **Paths** tab of the inspector. You can create, name and delete paths, choose the main one and the start node, add visits of the same scene and link existing nodes. **Add visit** also creates a connection from the selected node: an unreachable node can never be saved. Visits and connections are numbered lists: pick a visit to edit its scene and hold time, and a connection to edit its label, condition, duration or track; the details appear only for the chosen item. A label such as “Explore B” is the text of the public choice button.

For a cycle, first use **Enable manual loop (3 visits)**: it adds the policy and makes every existing connection manual. Adjust the limit in its field, then link the way back. The **Visit limit** condition further restricts entries to the target. The player never repeats on its own: a manual connection always needs an explicit choice. You can stop, go Back or change path; at the limit, the button says why it is disabled.

**Independent camera** sets a world pose on the node, distinct from the scene. In **Camera and timeline**, select a connection and use **Create a three-keyframe track**, or link an existing track. Edit normalized times 0..1, positions, Euler angles and zoom by opening each keyframe. The ends must stay at 0 and 1 and the order must be strictly increasing. You can add points and remove intermediate ones, choose Linear or Catmull-Rom and a track easing. The connection easing applies only without a track.

**Scrub camera** moves the real preview without emitting cues or changing visit. **End camera inspection** restores the recorded pose. The presentation lands on the last keyframe, even when it differs from the scene fit. After an interruption, the first runtime keyframe starts from the actual camera. A turn beyond 180° needs intermediate keyframes; when points reach or pass behind the perspective plane, the panel shows a warning and the Text view stays available.

**Declarative cues** have a namespaced name (for example `presentation.mark`), a time in milliseconds within the duration and a JSON payload. They are data and events for a host; Studio never executes code from the project. Overview, pan and zoom in the Camera menu are temporary inspection. Saving and recovery include all the new data, without selection, scrub state or UI history.

To try the complete document, open `examples/structure-branching/project.json` in Studio, or `/structure` in the playground. From A choose B or C, then D; Back returns along the branch actually taken. B is a child of A and branch B uses a track with an independent endpoint. D allows a limited return, and the alternative path shows the same scene in a separate itinerary.

## Blocks and resources

The current document is schema 1.3.0. Opening 1.0.0, 1.1.0 or 1.2.0 migrates a copy, keeping scenes, paths, notes, text and extensions; saving a new copy preserves the predecessor.

In the inspector, **Blocks** keeps the reading order. **Add text** keeps the historical literal text; **Block type** and **Add block** add Markdown, HTML, SVG, LaTeX, image, audio, video, internal link, embed or plugin. Sources are text areas with a preview in the shared player. **_type_ data** exposes every typed JSON field (alt, label, display, assetId, posterAssetId, captionsAssetId, link target, autoplay, loop, onExit). An invalid value shows the error and keeps the previous document. Move up, Move down and Delete, the icons at the top right of each block, are undoable commands. The local badge also has a separate inspector for its label; the document plugin settings are editable in their JSON field, in the collapsible section below the blocks.

In **flow** scenes, blocks are stacked vertically in reading order; position, size, rotation, layer, colours and fonts are chosen with the layout tools described in the next section. Do not use HTML or Markdown for layout: styles, classes and embedded images are removed by sanitization.

In **Resources**, first add a file with **Add resource**, then the image, audio or video block (SVG with an XML prologue, comments or a DOCTYPE, and UTF-8 text files of any length are accepted; this also works when Studio is served over HTTP from an address other than localhost): the block uses the first asset of the matching type, editable in its data. The panel shows name, ID, MIME type and size; the JSON exposes the full registry. **Link missing file** checks the original size, signature and digest. **Replace** updates the metadata keeping the ID; undo brings back the previous bytes kept in memory. Files are never written into the document as blob URLs.

**Save JSON** keeps the references and needs the files alongside, or linking them by hand after opening. **Save archive** produces a portable `.xcursus` file with every verified asset; if a file is missing, it says which one to link. **Open** accepts both formats; an invalid archive leaves the current work untouched. The limits are 10 MiB for a JSON file and 220 MiB for an archive; the message says which one was exceeded. Autosave and recovery include the resources of the kept revisions and remain distinct from an exported backup.

Audio and video have native controls and a **Play _label_** button; videos stay inline on phones too (`playsinline`); **Enable media** authorizes autoplaying blocks in the current player. No audible autoplay is guaranteed. On exit, `pause` keeps the time and `stop` resets it; destroy stops and releases everything. The Studio preview is muted; the presentation can play audio. Editing a block updates only that block in the preview: a playing video is not interrupted when you edit something else. Set a label, an alt text and a VTT asset as the video's captions. Unavailable codecs or files show messages and a recovery action in the Resources panel. Cues and media do not guarantee sample-accurate sync.

To try every block type, open `/content` in the playground and download the gallery archive, or open `examples/content-gallery/content-gallery.xcursus` in Studio. Local content works without Internet once the app has loaded; embeds are off and missing plugins keep their data and show a placeholder. See the [policy and SDK](PLUGINS.md).

## Layout

Select a scene and press **Layout** in the preview header. The preview is always the shared player: the scene is framed head-on and only outlines and handles appear on top, never a copy of the blocks. The map shrinks to make room; press **Layout** again to return to the normal preview.

**Flow and canvas.** A **flow** scene stacks its blocks as before. **Convert to canvas** measures the blocks in the preview and creates a frame for each, in a single command: the scene looks the same but every block becomes movable. **Switch to flow** asks for confirmation, because positions, sizes, rotations and layers are lost; Undo restores them.

**Frames.** In canvas each block has a frame in scene pixels, with the origin at the top left corner: X, Y, width and height (at least 8 px), rotation around the centre (−360…360°) and an integer z layer (−1000…1000). The unrotated frame must stay inside the scene; a rotated part that sticks out and text that overflows the frame are clipped, and the diagnostics report it. Images, SVG and videos fill the frame: images with the fit chosen in their data (`contain` or `cover`), videos leaving room for the play button.

**Gestures.** Click an outline to select it; Shift/Cmd/Ctrl+click adds it to or removes it from the selection; click the scene background to deselect. Drag an outline to move it (several selected outlines move together), a handle to resize while the opposite edge stays put, and the ↻ handle to rotate (in 15° steps with Shift). Each gesture is a single command: Undo restores it entirely, and Escape during the gesture cancels it without a trace. With **Snap to grid**, moves and resizes snap to the chosen step (8–64 px).

**Keyboard and fields.** Every outline and handle is reachable with Tab, with visible focus and short announcements. Enter or Space selects, Shift+Enter adds. On an outline the arrows move by 1 px, by 10 px with Shift; on a handle they resize; on the ↻ handle they rotate by 1° (15° with Shift). Holding a key down produces a single command. In the **Layout** panel of the inspector, Arrangement section, the X, Y, R, W, H and Z fields (named X frame, Y frame, Frame rotation, Frame width, Frame height and Z layer for screen readers) are the numeric alternative to every drag. Select all, deselect and switching back to flow are the icons next to the panel title. Delete and Backspace inside the scene editor never delete the scene.

**Align, distribute, layers.** These are the two icon bars below the frame fields (align and distribute; layers and grid), each icon with its name on hover. With a single block selected, Align uses the scene as reference; with several, their visual bounds. **Distribute** needs three blocks and makes the gaps equal. **Bring forward** and **Send backward** change z by 1; **Bring to front** and **Send to back** put the block above or below all the others.

**Reading order.** The **Reading order** list is the order of the blocks in the document: the order of the DOM, of the Tab key, of the text view and of screen readers. The ↑/↓ arrows change it without touching positions or layers; the z layer only decides what covers what. So arrange the list in the order the content should be read, even when it differs visually.

**Appearance and style.** **Scene appearance**: a card with a border or plain without one, a background from the palette (or the variant's default) and a visible or hidden title. A hidden title remains the accessible name of the scene and appears in the text view. **Block style**, for the selected blocks: text alignment and vertical alignment within the frame (two icon groups; a second click on the active option returns to the default), size (XS–XXL relative to the theme body) and colour from the palette. They also apply in flow scenes, by selecting the block in the Reading order list.

**Document theme.** The **Theme** tab of the inspector holds the palette (up to 32 `#rrggbb` colours), the roles (text, card background, accent and border, backdrop), the body and heading fonts and the type scale in px. Fonts are local only: three system families and Atkinson Hyperlegible, bundled with the project under the SIL OFL 1.1 and downloaded by the browser only when a document uses it. No field accepts CSS: every value is picked from validated lists.

**Diagnostics.** The Layout panel reports palette contrast below 4.5:1 for text or 3:1 for the border, blocks clipped by their own frame, frames covering the interactive controls (links, buttons, media) of a block underneath, blocks inside the band of a visible canvas title (a long title wraps over the frames) and flow scenes whose content is taller than the scene (it scrolls in the spatial view and is cut in PDF and video). Studio neither corrects colours nor resizes text: the decision is yours.

**Saving and presenting.** JSON, archive, autosave and recovery keep frames, style, appearance and theme; the presentation and the vanilla player render the same result. To try it, open `examples/layout-canvas/layout-canvas.xcursus` in Studio, or `/layout` in the playground, which also opens projects saved by Studio with **Open local project**: a hidden title, image and text side by side, an overlapping rotated stamp, a rotated note, a plain flow scene and a rotated child scene with columns and a link. In canvas scenes, reading at 320 px relies on the text view, not on the spatial view.

## Presenter, export and offline use

**Presenter** opens, with the same click, the audience window of the presentation and turns Studio into the presenter console: current scene, a preview of the next one or the buttons of the branch choices (also when the only exit is a manual connection, which always needs an explicit choice), the scene's **private notes**, a timer (Start, Pause, Reset) and Back/Next; the arrows work on the console. The console is the only one in charge: keys, the text view and choices in the audience window become requests to the console. Notes never reach the audience window; the previews are muted and audio plays only in the audience window. In the audience window the audience sees only the scene: the player controls appear when the pointer moves or with keyboard focus. **Full screen** requests browser full screen (move the window to the audience screen first: choosing the monitor is up to the browser and the system). If the browser blocks the pop-up, the console explains how to allow it and offers **Try opening again** or **Present in this tab**. If the audience window reloads, it resyncs on its own; if Studio reloads, reopen the presented project and press **Resume presenter view**. **End** closes the session. The presenter view needs Studio served from a local host or over HTTPS.

**Export.** Standalone HTML, a static web build, PDF and video are produced with the `xcursus` command (see [DISTRIBUTION](DISTRIBUTION.md)) from the saved JSON with its resources alongside, or from the `.xcursus` archive. The PDF has one page per visit of an explicit itinerary; the video has no audio and accepts only text, Markdown, HTML, SVG, formulas, images and camera moves. Embeds, plugins and remote resources are not exported in strict mode. Private notes never enter any export.

**Offline.** Production Studio registers an offline shell after the first load: it reopens without a network and local projects come back from recovery. A new version shows **Update and reload**: it first saves the work to local recovery and never deletes projects; **Later** keeps the current version. IndexedDB remains a recovery store, not a backup: save JSON or an archive.
