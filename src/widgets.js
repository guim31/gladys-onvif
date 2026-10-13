// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `camera`.
//
// The Gladys camera box shows the image, and its PTZ pad only over a live
// stream, which an integration camera does not have. What this widget adds:
// the image with up to four one-tap buttons (directions, zoom or preset
// positions, chosen in its settings) that move the camera and bring back the
// new view, and what the camera detects right now.
//
// Budget (8 components, 2 texts, 1 status, 4 buttons): a caption, the image,
// one status list, up to four buttons.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { MOVES, kindName, moveName, namesFor, presetLabel, supportedMoves } from './devices.js';
import { WIDGET_KEY } from './hub.js';
import { SENSOR_KINDS } from './onvif/events.js';

export const CONTROLS = ['directions', 'zoom_presets', 'presets', 'none'];
export const DEFAULT_CONTROLS = 'directions';
const MAX_BUTTONS = 4;
const MAX_STATUS = 4;
const MOVE_ACTION = 'move_';
const PRESET_ACTION = 'preset_';
// How long `get` waits for a first image before showing the caption alone.
const FIRST_IMAGE_WAIT_MS = 8000;

const MOVE_ICONS = {
  [MOVES.PAN_LEFT]: 'arrow-left',
  [MOVES.PAN_RIGHT]: 'arrow-right',
  [MOVES.TILT_UP]: 'arrow-up',
  [MOVES.TILT_DOWN]: 'arrow-down',
  [MOVES.ZOOM_IN]: 'zoom-in',
  [MOVES.ZOOM_OUT]: 'zoom-out',
};

export const TEXT = {
  pick: {
    en: 'Choose a camera in the settings of this widget.',
    fr: 'Choisissez une caméra dans les réglages de ce widget.',
    de: 'Wähle in den Einstellungen dieses Widgets eine Kamera aus.',
    es: 'Elija una cámara en la configuración de este widget.',
  },
  unknown: {
    en: 'This camera is not known yet: run a search in the integration.',
    fr: 'Cette caméra est inconnue : lancez une recherche dans l’intégration.',
    de: 'Diese Kamera ist noch unbekannt: Starte eine Suche in der Integration.',
    es: 'Esta cámara aún no es conocida: inicie una búsqueda en la integración.',
  },
  imageAt: { en: 'Image', fr: 'Image', de: 'Bild', es: 'Imagen' },
  noImage: {
    en: 'No image yet',
    fr: 'Pas encore d’image',
    de: 'Noch kein Bild',
    es: 'Aún no hay imagen',
  },
  unreachable: {
    en: 'not answering',
    fr: 'ne répond pas',
    de: 'antwortet nicht',
    es: 'no responde',
  },
  detected: { en: 'Detected', fr: 'Détecté', de: 'Erkannt', es: 'Detectado' },
  clear: { en: 'Nothing', fr: 'Rien', de: 'Nichts', es: 'Nada' },
  presetReached: {
    en: 'Preset position: ',
    fr: 'Position mémorisée : ',
    de: 'Gespeicherte Position: ',
    es: 'Posición predefinida: ',
  },
};

const t = (text, language) => text[language] ?? text.en;

/** The short id of a source in its image keys. */
export function imageId(externalId) {
  return createHash('sha1').update(externalId).digest('hex').slice(0, 12);
}

export function imageKey(externalId, seq) {
  return `cam-${imageId(externalId)}-${seq.toString(36)}`;
}

/** The presets named in the settings (names or numbers), else the first ones. */
export function widgetPresets(presets, setting, count) {
  const wanted = String(setting ?? '')
    .split(/[,;\n]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (wanted.length === 0) {
    return presets.slice(0, count);
  }
  const chosen = [];
  for (const name of wanted) {
    const preset = presets.find(
      (item) => String(item.name).trim().toLowerCase() === name || String(item.value) === name,
    );
    if (preset && !chosen.includes(preset)) {
      chosen.push(preset);
    }
  }
  return chosen.slice(0, count);
}

/** The buttons of the widget: `[{ label, icon, action }]`, at most four. */
export function widgetButtons(hub, source, settings, language) {
  const controls = CONTROLS.includes(settings?.controls) ? settings.controls : DEFAULT_CONTROLS;
  const moves = supportedMoves(source.ptz);
  const presets = hub.presets(source);
  const buttons = [];
  const addMove = (value) => {
    if (moves.includes(value)) {
      buttons.push({
        type: 'button',
        label: moveName(value, language),
        icon: MOVE_ICONS[value],
        style: 'secondary',
        // Numbered keys: the core drops a button whose action key is taken.
        action: { key: `${MOVE_ACTION}${buttons.length + 1}`, params: { value } },
      });
    }
  };
  const addPresets = (count) => {
    for (const preset of widgetPresets(presets, settings?.presets, count)) {
      buttons.push({
        type: 'button',
        label: presetLabel(preset, language).slice(0, 24),
        icon: 'map-pin',
        style: 'secondary',
        action: { key: `${PRESET_ACTION}${buttons.length + 1}`, params: { value: preset.value } },
      });
    }
  };
  if (controls === 'directions') {
    [MOVES.PAN_LEFT, MOVES.TILT_UP, MOVES.TILT_DOWN, MOVES.PAN_RIGHT].forEach(addMove);
  } else if (controls === 'zoom_presets') {
    [MOVES.ZOOM_OUT, MOVES.ZOOM_IN].forEach(addMove);
    addPresets(MAX_BUTTONS - buttons.length);
  } else if (controls === 'presets') {
    addPresets(MAX_BUTTONS);
  }
  return buttons.slice(0, MAX_BUTTONS);
}

function message(text, language) {
  return {
    ttl_seconds: 300,
    components: [{ type: 'text', variant: 'body', text: t(text, language) }],
  };
}

function timeOf(at, language) {
  return new Intl.DateTimeFormat(language, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(at));
}

async function get(hub, { settings, language = 'en' }) {
  const found = settings?.camera ? hub.resolveDevice(settings.camera) : null;
  if (!found) {
    return message(settings?.camera ? TEXT.unknown : TEXT.pick, language);
  }
  const { camera, source } = found;
  if (!source.image && camera.reachable === true) {
    // The first look at this camera: wait a little for an image.
    const first = hub.refreshImage(camera, source).catch(() => null);
    await Promise.race([first, new Promise((resolve) => setTimeout(resolve, FIRST_IMAGE_WAIT_MS))]);
  }
  const caption = [
    source.image
      ? `${t(TEXT.imageAt, language)} ${timeOf(source.image.at, language)}`
      : t(TEXT.noImage, language),
  ];
  if (camera.reachable !== true) {
    caption.push(t(TEXT.unreachable, language));
  }
  const components = [{ type: 'text', variant: 'caption', text: caption.join(' · ') }];
  if (source.image) {
    components.push({
      type: 'image',
      key: imageKey(settings.camera, source.imageSeq),
      alt: `${namesFor(language).camera} ${camera.info?.model ?? ''}`.trim(),
      fit: 'contain',
    });
  }
  const items = SENSOR_KINDS.filter((kind) => camera.kinds.includes(kind))
    .slice(0, MAX_STATUS)
    .map((kind) => {
      const on = hub.detected(source, kind);
      return {
        label: kindName(kind, language),
        icon: kind === 'tamper' ? 'shield' : 'eye',
        value: t(on ? TEXT.detected : TEXT.clear, language),
        color: on ? WIDGET_COLORS.WARNING : WIDGET_COLORS.NEUTRAL,
      };
    });
  if (items.length > 0) {
    components.push({ type: 'status', items });
  }
  components.push(...widgetButtons(hub, source, settings, language));
  return {
    ttl_seconds: Math.min(Math.max(hub.config.snapshotSeconds, 10), 300),
    components,
  };
}

async function action(hub, { actionKey, params = {}, settings }) {
  const device = settings?.camera;
  if (!device) {
    throw new Error(TEXT.pick.en);
  }
  const value = Number(params.value);
  if (actionKey.startsWith(MOVE_ACTION)) {
    await hub.move(device, value);
    // Resolve with the new view: the widget reloads when the action ends.
    await hub.freshImageAfter(device, hub.config.moveMs + hub.timings.imageAfterMoveMs);
    return {
      message: Object.fromEntries(
        Object.keys(TEXT.detected).map((language) => [language, moveName(value, language)]),
      ),
    };
  }
  if (actionKey.startsWith(PRESET_ACTION)) {
    const preset = await hub.gotoPreset(device, value);
    await hub.freshImageAfter(device, hub.timings.imageAfterPresetMs);
    return {
      message: Object.fromEntries(
        Object.keys(TEXT.presetReached).map((language) => [
          language,
          `${TEXT.presetReached[language]}${presetLabel(preset, language)}`,
        ]),
      ),
    };
  }
  throw new Error(`Unknown action ${actionKey}`);
}

/** The bytes behind an image key of the widget (raw base64). */
export function widgetImage(hub, key) {
  const match = /^cam-([0-9a-f]{12})-[0-9a-z]+$/.exec(String(key));
  if (!match) {
    throw new Error(`Unknown image ${key}`);
  }
  for (const camera of hub.cameras.values()) {
    for (const source of camera.sources) {
      if (imageId(hub.ids(camera, source).device) === match[1]) {
        if (!source.image) {
          throw new Error(`No image yet for ${key}`);
        }
        return source.image.jpeg.toString('base64');
      }
    }
  }
  throw new Error(`Unknown image ${key}`);
}

export const WIDGETS = {
  [WIDGET_KEY]: { get, action },
};
