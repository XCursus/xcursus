# Paint-order fixtures

Two small documents that reproduce a Firefox (Gecko) 3D-sorting defect: child scenes 30 px in front of a very large section are drawn behind it when another large or tilted plane is sorted first. They contain geometry only and are original test data (CC0-1.0).

- `tilted-section.json`: a section of 8400×5600 tilted 12° about X with two child scenes, and a small scene turned −8° about Y painted before it.
- `wide-sections.json`: a wall of 12400×8600 and a panel of 9000×3200 turned 15° about Y with two child scenes; the plane of the wall cuts the panel.

The player paints scene wrappers in an order that avoids the faulty splits in Firefox (`packages/player/src/paint.ts`); `packages/player/test/paint.test.ts` checks the order and `tests/e2e/paint.spec.ts` checks in every engine that the child scenes are drawn.
