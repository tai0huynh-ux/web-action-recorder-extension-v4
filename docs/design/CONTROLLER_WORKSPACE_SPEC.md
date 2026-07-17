# Controller Workspace Phase 1 Specification

Updated: 2026-07-17

Phase 1 adds a localized three-pane Electron Controller workspace based on:

- `docs/design/container-action-workspace-reference.png`
- `docs/design/input-group-grid-reference.png`

The images are tracked reference artifacts only. They are not used as application backgrounds.

## Layout

Desktop panes:

- Left: machines and containers.
- Center: draft input configuration.
- Right: action graph preview.

Sizing:

- Left pane: min 220px, default 280px, max 380px.
- Center pane: min 320px, default 420px, max 600px.
- Graph pane: flex remainder with a desktop minimum of 480px.

Narrow widths stack the panes and expose a toolbar for `Máy`, `Nhập liệu`, and `Luồng hành động`.

## Responsibilities

Machines and containers render real `store.devices` records. Selection is renderer-only and supports single select, Ctrl/cmd multi-select, Shift range select, select all visible, clear selection, Arrow Up/Down, Space, Ctrl+A, and Escape.

Input configuration has `Văn bản`, `Bảng`, and `Chọn ô` modes. It shows draft state only and does not build an execution payload.

The action graph renders a read-only renderer fixture when no workflow is selected. It follows the current action vocabulary and does not introduce a second workflow graph schema.

## Localization

Default locale is `vi`; fallback locale is `en`. The language dropdown switches at runtime and persists through typed Controller IPC settings. Missing keys fall back to English; if English is missing, the key is returned.

## Accessibility

Controls have visible labels or explicit accessible names. Device cards use `role="option"` and `aria-selected`. Resize handles use `role="separator"`, vertical orientation, value bounds, and keyboard Arrow Left/Right handling. Focus-visible styles are defined for controls and graph surfaces.

## Explicit Deferrals

- `Add Container backend: NOT_IMPLEMENTED_PHASE_1`
- `Field picker backend: NOT_IMPLEMENTED_PHASE_1`
- `Grouped input execution: NOT_IMPLEMENTED_PHASE_1`
- `Origin synchronization: NOT_IMPLEMENTED_PHASE_1`

Next phase: `PHASE_2_GROUPED_INPUT_MAPPING`.
