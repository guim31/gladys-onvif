// -----------------------------------------------------------------------------
// Texts the integration sends to Gladys outside the widget (src/widgets.js):
// connection status, transport badge and the "Search for cameras" report. Four
// languages, the four of the Gladys interface; German says "du", Spanish
// "usted". test/i18n.test.js checks every table.
// -----------------------------------------------------------------------------

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

// Shown by Gladys under the integration name when it is not connected, and on
// the transport badge of a camera that refuses its account.
export const CONNECTION_TEXT = {
  noCamera: {
    en: 'No ONVIF camera found. Turn ONVIF on in the camera, or enter its address.',
    fr: 'Aucune caméra ONVIF trouvée. Activez ONVIF dans la caméra, ou saisissez son adresse.',
    de: 'Keine ONVIF-Kamera gefunden. Aktiviere ONVIF in der Kamera oder gib ihre Adresse ein.',
    es: 'No se ha encontrado ninguna cámara ONVIF. Active ONVIF en la cámara o introduzca su dirección.',
  },
  refused: {
    en: 'A camera answered but refused the user name and password: check the accounts.',
    fr: "Une caméra a répondu mais a refusé l'identifiant et le mot de passe : vérifiez les comptes.",
    de: 'Eine Kamera hat geantwortet, aber Benutzername und Passwort abgelehnt: Prüfe die Konten.',
    es: 'Una cámara ha respondido pero ha rechazado el usuario y la contraseña: compruebe las cuentas.',
  },
  noAnswer: {
    en: 'No ONVIF camera answers.',
    fr: 'Aucune caméra ONVIF ne répond.',
    de: 'Keine ONVIF-Kamera antwortet.',
    es: 'Ninguna cámara ONVIF responde.',
  },
  authError: {
    en: 'The camera refuses its account: check the user name and password.',
    fr: "La caméra refuse son compte : vérifiez l'identifiant et le mot de passe.",
    de: 'Die Kamera lehnt ihr Konto ab: Prüfe Benutzername und Passwort.',
    es: 'La cámara rechaza su cuenta: compruebe el usuario y la contraseña.',
  },
};

const MAX_LISTED = 8;

// The pieces of the "Search" report, one table per language.
export const SEARCH_TEXT = {
  en: {
    none: 'No ONVIF camera found.',
    count: (total, reachable) => `${total} camera(s), ${reachable} answering:`,
    unreachable: 'not answering',
    refused: 'account refused',
    ptz: 'PTZ',
    presets: (count) => `${count} preset(s)`,
    events: 'events',
    failedAuth: (list) => `Account refused by ${list}: check the user name and password.`,
    failedOther: (list) => `No ONVIF camera at ${list} (ONVIF off, or another port).`,
    failedUnreachable: (list) => `No answer from ${list}.`,
    unavailable:
      'Automatic discovery through Gladys is unavailable (Gladys 5.1 or later needed): enter the addresses.',
    busy: 'A search has just run: the automatic discovery is available again in 10 seconds.',
    ignored: (list) => `Ignored addresses: ${list}.`,
  },
  fr: {
    none: 'Aucune caméra ONVIF trouvée.',
    count: (total, reachable) => `${total} caméra(s), ${reachable} répondent :`,
    unreachable: 'ne répond pas',
    refused: 'compte refusé',
    ptz: 'PTZ',
    presets: (count) => `${count} position(s) mémorisée(s)`,
    events: 'événements',
    failedAuth: (list) => `Compte refusé par ${list} : vérifiez l'identifiant et le mot de passe.`,
    failedOther: (list) => `Pas de caméra ONVIF à ${list} (ONVIF désactivé, ou autre port).`,
    failedUnreachable: (list) => `Pas de réponse de ${list}.`,
    unavailable:
      'La découverte automatique par Gladys est indisponible (Gladys 5.1 ou plus récent) : saisissez les adresses.',
    busy: 'Une recherche vient de tourner : la découverte automatique est de nouveau possible dans 10 secondes.',
    ignored: (list) => `Adresses ignorées : ${list}.`,
  },
  de: {
    none: 'Keine ONVIF-Kamera gefunden.',
    count: (total, reachable) => `${total} Kamera(s), davon ${reachable} erreichbar:`,
    unreachable: 'antwortet nicht',
    refused: 'Konto abgelehnt',
    ptz: 'PTZ',
    presets: (count) => `${count} gespeicherte Position(en)`,
    events: 'Ereignisse',
    failedAuth: (list) => `Konto abgelehnt von ${list}: Prüfe Benutzername und Passwort.`,
    failedOther: (list) => `Keine ONVIF-Kamera unter ${list} (ONVIF aus oder anderer Port).`,
    failedUnreachable: (list) => `Keine Antwort von ${list}.`,
    unavailable:
      'Die automatische Erkennung über Gladys ist nicht verfügbar (Gladys 5.1 oder neuer nötig): Gib die Adressen ein.',
    busy: 'Gerade lief eine Suche: Die automatische Erkennung ist in 10 Sekunden wieder möglich.',
    ignored: (list) => `Ignorierte Adressen: ${list}.`,
  },
  es: {
    none: 'No se ha encontrado ninguna cámara ONVIF.',
    count: (total, reachable) => `${total} cámara(s), ${reachable} responden:`,
    unreachable: 'no responde',
    refused: 'cuenta rechazada',
    ptz: 'PTZ',
    presets: (count) => `${count} posición(es) predefinida(s)`,
    events: 'eventos',
    failedAuth: (list) => `Cuenta rechazada por ${list}: compruebe el usuario y la contraseña.`,
    failedOther: (list) => `No hay cámara ONVIF en ${list} (ONVIF desactivado u otro puerto).`,
    failedUnreachable: (list) => `Sin respuesta de ${list}.`,
    unavailable:
      'El descubrimiento automático a través de Gladys no está disponible (se necesita Gladys 5.1 o posterior): introduzca las direcciones.',
    busy: 'Acaba de realizarse una búsqueda: el descubrimiento automático vuelve a estar disponible en 10 segundos.',
    ignored: (list) => `Direcciones ignoradas: ${list}.`,
  },
};

const listOf = (items) =>
  items.length > MAX_LISTED ? `${items.slice(0, MAX_LISTED).join(', ')}…` : items.join(', ');

/** The report of the "Search for cameras" action, in the four languages. */
export function searchMessage(summary) {
  const message = {};
  for (const [language, text] of Object.entries(SEARCH_TEXT)) {
    const lines = [];
    const cameras = summary.cameras ?? [];
    if (cameras.length === 0) {
      lines.push(text.none);
    } else {
      const reachable = cameras.filter((camera) => camera.reachable).length;
      lines.push(text.count(cameras.length, reachable));
      for (const camera of cameras.slice(0, MAX_LISTED)) {
        const flags = [];
        if (!camera.reachable) {
          flags.push(text.unreachable);
        } else if (camera.authError) {
          flags.push(text.refused);
        }
        if (camera.ptz) {
          flags.push(text.ptz);
        }
        if (camera.presets > 0) {
          flags.push(text.presets(camera.presets));
        }
        if (camera.events) {
          flags.push(text.events);
        }
        lines.push(
          `- ${camera.name} (${camera.host})${flags.length ? `: ${flags.join(', ')}` : ''}`,
        );
      }
    }
    const failed = (reason) =>
      (summary.failures ?? [])
        .filter((failure) => failure.reason === reason)
        .map((failure) => (failure.port === 80 ? failure.host : `${failure.host}:${failure.port}`));
    if (failed('auth').length > 0) {
      lines.push(text.failedAuth(listOf(failed('auth'))));
    }
    if (failed('error').length > 0) {
      lines.push(text.failedOther(listOf(failed('error'))));
    }
    if (failed('unreachable').length > 0) {
      lines.push(text.failedUnreachable(listOf(failed('unreachable'))));
    }
    if (summary.scan === 'unavailable') {
      lines.push(text.unavailable);
    } else if (summary.scan === 'busy') {
      lines.push(text.busy);
    }
    if (summary.invalidHosts?.length > 0) {
      lines.push(text.ignored(listOf(summary.invalidHosts)));
    }
    message[language] = lines.join('\n');
  }
  return message;
}
