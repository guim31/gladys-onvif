// -----------------------------------------------------------------------------
// Scene actions (manifest `scene_actions`, Gladys 5.1+).
//
// Gladys can already set the `camera/preset` and `camera/move` features from
// a scene ("Control a device"), but with raw numbers: what these actions add
// is the preset by its NAME (as the camera app shows it) and a move of a given
// duration, by direction. Taking a picture needs no action of ours: the core's
// "Send a camera image" asks the integration for a fresh image.
// -----------------------------------------------------------------------------

import { MOVES } from './devices.js';

export const DIRECTIONS = {
  left: MOVES.PAN_LEFT,
  right: MOVES.PAN_RIGHT,
  up: MOVES.TILT_UP,
  down: MOVES.TILT_DOWN,
  zoom_in: MOVES.ZOOM_IN,
  zoom_out: MOVES.ZOOM_OUT,
};

export const MOVE_SECONDS = { min: 1, max: 10, default: 2 };

async function gotoPreset(hub, { fields }) {
  if (!fields?.camera) {
    throw new Error('Choose a camera');
  }
  const wanted = String(fields.preset ?? '').trim();
  if (!wanted) {
    throw new Error('Name the preset position');
  }
  const preset = await hub.gotoPreset(fields.camera, wanted);
  return { preset: preset.name || String(preset.value) };
}

async function moveCamera(hub, { fields }) {
  if (!fields?.camera) {
    throw new Error('Choose a camera');
  }
  const value = DIRECTIONS[fields.direction];
  if (value === undefined) {
    throw new Error(`Unknown direction "${fields.direction}"`);
  }
  const raw = fields.duration;
  const given = raw === undefined || raw === null || raw === '' ? Number.NaN : Number(raw);
  const seconds = Number.isFinite(given)
    ? Math.min(Math.max(given, MOVE_SECONDS.min), MOVE_SECONDS.max)
    : MOVE_SECONDS.default;
  await hub.moveFor(fields.camera, value, seconds);
}

export const SCENE_ACTIONS = {
  goto_preset: gotoPreset,
  move_camera: moveCamera,
};
