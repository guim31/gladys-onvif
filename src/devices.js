// -----------------------------------------------------------------------------
// What a camera becomes in Gladys: one device per video source (a camera has
// one, a recorder or a multi-lens camera several), with
//   - its image (`camera/image`), pushed by the integration;
//   - when the camera moves: the movement command of the Gladys PTZ contract
//     (`camera/move`, values 1-6, 0 = stop) and its preset positions
//     (`camera/preset`, the list in `supported_options`);
//   - one sensor per detection the camera reports (motion, person, vehicle,
//     animal, line crossing, intrusion: `motion-sensor/binary`, 1 = detected;
//     tampering: `tamper/binary`).
//
// Feature keys are forever: they are part of the external ids.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { SENSOR_KINDS } from './onvif/events.js';

export const DEVICE_TYPE = 'camera';

export const FEATURE_KEYS = {
  IMAGE: 'image',
  MOVE: 'move',
  PRESET: 'preset',
};

// Detection kind → feature key (the kinds are the trigger values).
export const KIND_FEATURES = {
  motion: 'motion',
  person: 'person',
  vehicle: 'vehicle',
  animal: 'animal',
  line_crossing: 'line-crossing',
  intrusion: 'intrusion',
  tamper: 'tamper',
};

// The canonical values of the Gladys PTZ contract (CAMERA_MOVE).
export const MOVES = {
  STOP: 0,
  PAN_LEFT: 1,
  PAN_RIGHT: 2,
  TILT_UP: 3,
  TILT_DOWN: 4,
  ZOOM_IN: 5,
  ZOOM_OUT: 6,
};

const MOVE_KEYS = {
  [MOVES.PAN_LEFT]: 'panLeft',
  [MOVES.PAN_RIGHT]: 'panRight',
  [MOVES.TILT_UP]: 'tiltUp',
  [MOVES.TILT_DOWN]: 'tiltDown',
  [MOVES.ZOOM_IN]: 'zoomIn',
  [MOVES.ZOOM_OUT]: 'zoomOut',
};

// Feature, device and movement names, frozen when the user adds the device.
// The movement labels are those of the Gladys interface.
export const NAMES = {
  en: {
    camera: 'Camera',
    image: 'Image',
    move: 'Movement (PTZ)',
    preset: 'Preset position',
    motion: 'Motion detection',
    person: 'Person detection',
    vehicle: 'Vehicle detection',
    animal: 'Animal detection',
    line_crossing: 'Line crossing',
    intrusion: 'Intrusion detection',
    tamper: 'Tampering',
    sound: 'Sound detection',
    doorbell: 'Doorbell',
    panLeft: 'Left',
    panRight: 'Right',
    tiltUp: 'Up',
    tiltDown: 'Down',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    preset_n: 'Preset',
  },
  fr: {
    camera: 'Caméra',
    image: 'Image',
    move: 'Mouvement (PTZ)',
    preset: 'Position mémorisée',
    motion: 'Détection de mouvement',
    person: 'Détection de personne',
    vehicle: 'Détection de véhicule',
    animal: 'Détection d’animal',
    line_crossing: 'Franchissement de ligne',
    intrusion: 'Détection d’intrusion',
    tamper: 'Sabotage',
    sound: 'Détection de son',
    doorbell: 'Sonnette',
    panLeft: 'Gauche',
    panRight: 'Droite',
    tiltUp: 'Haut',
    tiltDown: 'Bas',
    zoomIn: 'Zoomer',
    zoomOut: 'Dézoomer',
    preset_n: 'Position',
  },
  de: {
    camera: 'Kamera',
    image: 'Bild',
    move: 'Kamerabewegung (PTZ)',
    preset: 'Gespeicherte Position',
    motion: 'Bewegungserkennung',
    person: 'Personenerkennung',
    vehicle: 'Fahrzeugerkennung',
    animal: 'Tiererkennung',
    line_crossing: 'Linienüberschreitung',
    intrusion: 'Einbruchserkennung',
    tamper: 'Manipulation',
    sound: 'Geräuscherkennung',
    doorbell: 'Türklingel',
    panLeft: 'Links',
    panRight: 'Rechts',
    tiltUp: 'Hoch',
    tiltDown: 'Runter',
    zoomIn: 'Vergrößern',
    zoomOut: 'Verkleinern',
    preset_n: 'Position',
  },
  es: {
    camera: 'Cámara',
    image: 'Imagen',
    move: 'Movimiento (PTZ)',
    preset: 'Posición predefinida',
    motion: 'Detección de movimiento',
    person: 'Detección de personas',
    vehicle: 'Detección de vehículos',
    animal: 'Detección de animales',
    line_crossing: 'Cruce de línea',
    intrusion: 'Detección de intrusión',
    tamper: 'Manipulación',
    sound: 'Detección de sonido',
    doorbell: 'Timbre',
    panLeft: 'Izquierda',
    panRight: 'Derecha',
    tiltUp: 'Arriba',
    tiltDown: 'Abajo',
    zoomIn: 'Acercar',
    zoomOut: 'Alejar',
    preset_n: 'Posición',
  },
};

export const namesFor = (language) => NAMES[language] ?? NAMES.en;

/** The label of a detection kind (sensor or trigger only). */
export const kindName = (kind, language) => namesFor(language)[kind] ?? kind;

/** The label of a movement value. */
export const moveName = (value, language) => namesFor(language)[MOVE_KEYS[value]] ?? String(value);

/** A video source token as it can go in an external id. */
export function sanitizeToken(token) {
  const clean = String(token ?? '')
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .slice(0, 40);
  return clean || 'main';
}

/** The ids of one device: the camera's unique id plus its video source. */
export function deviceIds(gladys, uid, sourceToken) {
  return gladys.externalIds(DEVICE_TYPE, `${uid}_${sanitizeToken(sourceToken)}`);
}

/** The movement values a source can do (stop excluded), in order. */
export function supportedMoves(ptz) {
  if (!ptz) {
    return [];
  }
  const can = (axis) => ptz.continuous?.[axis] || ptz.relative?.[axis];
  const moves = [];
  if (can('pan')) {
    moves.push(MOVES.PAN_LEFT, MOVES.PAN_RIGHT);
  }
  if (can('tilt')) {
    moves.push(MOVES.TILT_UP, MOVES.TILT_DOWN);
  }
  if (can('zoom')) {
    moves.push(MOVES.ZOOM_IN, MOVES.ZOOM_OUT);
  }
  return moves;
}

function hashToken(token) {
  return createHash('sha1').update(token, 'utf8').digest().readUInt32BE(0);
}

/**
 * The integer each preset gets in Gladys, decided by its token alone so it
 * never changes across restarts: the token itself when it is a number (most
 * cameras: "1", "2"…), else the number it ends with ("PTZPresetToken_3": 3),
 * else a stable number from 100000 up.
 * @param {Array<{ token: string, name: string }>} presets
 * @returns {Array<{ token, name, value }>}
 */
export function presetValues(presets) {
  const taken = new Set();
  const result = [];
  const byToken = [...(presets ?? [])].sort((a, b) => (String(a.token) < String(b.token) ? -1 : 1));
  const assign = (preset, value) => {
    taken.add(value);
    result.push({ ...preset, value });
  };
  const left = [];
  for (const preset of byToken) {
    const token = String(preset.token);
    if (/^\d{1,5}$/.test(token) && !taken.has(Number(token))) {
      assign(preset, Number(token));
    } else {
      left.push(preset);
    }
  }
  const rest = [];
  for (const preset of left) {
    const ending = String(preset.token).match(/(\d{1,5})$/);
    if (ending && !taken.has(Number(ending[1]))) {
      assign(preset, Number(ending[1]));
    } else {
      rest.push(preset);
    }
  }
  for (const preset of rest) {
    let value = 100000 + (hashToken(String(preset.token)) % 900000);
    while (taken.has(value)) {
      value += 1;
    }
    assign(preset, value);
  }
  return result.sort((a, b) => a.value - b.value);
}

/** The name shown for a preset: its own, or "Position 3" when it has none. */
export function presetLabel(preset, language) {
  const name = String(preset.name ?? '').trim();
  return (name || `${namesFor(language).preset_n} ${preset.value}`).slice(0, 60);
}

/**
 * The features of one video source.
 * @param {object} source `{ ptz, presets }`
 * @param {string[]} kinds the detections the camera reports
 * @param {string} language
 */
export function featureSpecs(source, kinds, language) {
  const names = namesFor(language);
  const specs = [
    {
      key: FEATURE_KEYS.IMAGE,
      category: 'camera',
      type: 'image',
      name: names.image,
      min: 0,
      max: 0,
      read_only: true,
      has_feedback: false,
      keep_history: false,
    },
  ];
  const moves = supportedMoves(source.ptz);
  if (moves.length > 0) {
    specs.push({
      key: FEATURE_KEYS.MOVE,
      category: 'camera',
      type: 'move',
      name: names.move,
      min: 0,
      max: 6,
      read_only: false,
      has_feedback: false,
      keep_history: false,
      supported_options: moves.map((value, index) => ({
        value,
        label: moveName(value, language),
        sort_order: index,
      })),
    });
  }
  if (source.ptz && Array.isArray(source.presets)) {
    const presets = presetValues(source.presets);
    specs.push({
      key: FEATURE_KEYS.PRESET,
      category: 'camera',
      type: 'preset',
      name: names.preset,
      min: 0,
      max: presets.reduce((max, preset) => Math.max(max, preset.value), 0),
      read_only: false,
      has_feedback: false,
      keep_history: false,
      supported_options: presets.map((preset, index) => ({
        value: preset.value,
        label: presetLabel(preset, language),
        sort_order: index,
      })),
    });
  }
  for (const kind of SENSOR_KINDS) {
    if (!kinds.includes(kind)) {
      continue;
    }
    specs.push({
      key: KIND_FEATURES[kind],
      category: kind === 'tamper' ? 'tamper' : 'motion-sensor',
      type: 'binary',
      name: names[kind],
      min: 0,
      max: 1,
      read_only: true,
      has_feedback: true,
      keep_history: true,
    });
  }
  return specs;
}

/** "Hikvision DS-2CD2143G0-I", the source's name added when there are several. */
export function deviceName(camera, source, language) {
  const brand = camera.info?.manufacturer?.trim();
  const model = camera.info?.model?.trim();
  let name = [brand, model].filter(Boolean).join(' ') || `${namesFor(language).camera} ONVIF`;
  if (model && brand && model.toLowerCase().startsWith(brand.toLowerCase())) {
    name = model;
  }
  if (camera.sources.length > 1) {
    name = `${name} (${source.index + 1})`;
  }
  return name.slice(0, 80);
}

export function buildDevice(gladys, camera, source, language) {
  const ids = deviceIds(gladys, camera.uid, source.token);
  const params = [
    { name: 'IP_ADDRESS', value: camera.host },
    { name: 'ONVIF_PORT', value: String(camera.port) },
  ];
  if (camera.info?.manufacturer) {
    params.push({ name: 'MANUFACTURER', value: camera.info.manufacturer });
  }
  if (camera.info?.firmware) {
    params.push({ name: 'FIRMWARE', value: camera.info.firmware });
  }
  return {
    name: deviceName(camera, source, language),
    external_id: ids.device,
    model: camera.info?.model || 'ONVIF',
    // The container sends the images at its own pace (snapshot interval):
    // the Gladys scheduler has no use here.
    should_poll: false,
    params,
    features: featureSpecs(source, camera.kinds, language).map((spec) => {
      const feature = {
        name: spec.name,
        external_id: ids.feature(spec.key),
        category: spec.category,
        type: spec.type,
        min: spec.min,
        max: spec.max,
        read_only: spec.read_only,
        has_feedback: spec.has_feedback,
        keep_history: spec.keep_history,
      };
      if (spec.supported_options) {
        feature.supported_options = spec.supported_options;
      }
      return feature;
    }),
  };
}
