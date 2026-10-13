# ONVIF

Bring deine **ONVIF-IP-Kameras** in Gladys, über dein lokales Netzwerk:
Hikvision, Dahua, Amcrest, Reolink, TP-Link Tapo und VIGI, Axis, Foscam, Annke,
Uniview und die meisten Netzwerk-Videorekorder. Gladys findet sie, zeigt ihr
Bild, ohne dass du eine Stream-Adresse eingibst, schwenkt und zoomt die
motorisierten Kameras, ruft ihre gespeicherten Positionen auf und verfolgt,
was sie erkennen (Bewegung, Person, Fahrzeug, Tier, Linienüberschreitung,
Einbruch, Manipulation), mit einem Dashboard-Widget, einem Szenen-Auslöser und
zwei Szenen-Aktionen. Keine Cloud: Gladys spricht direkt mit jeder Kamera.

> **Ohne die Hardware entwickelt: Rückmeldungen willkommen.** Diese
> Integration wurde gegen den Happytime-ONVIF-Server (eine vollständige
> Software-Kamera), gegen simulierte Kameras, die wie Hikvision- und
> TP-Link-Tapo-Modelle antworten, und gegen echte Ereignis-Nachrichten aus dem
> Projekt onvif-parsers gebaut und getestet, nicht gegen eine echte Kamera.
> Wenn etwas nicht wie beschrieben funktioniert, sag es im
> [Gladys-Forum](https://community.gladysassistant.com) oder in den
> [Issues](https://github.com/guim31/gladys-onvif/issues).

## Was du brauchst

- Gladys Assistant 5.1.0 oder neuer.
- Kameras im selben Netzwerk wie Gladys, mit **aktiviertem ONVIF**, und
  Benutzername und Passwort eines ONVIF-Kontos. Wo du sie findest:
  - **TP-Link Tapo**: in der Tapo-App, Kameraeinstellungen, **Erweiterte
    Einstellungen** → **Kamerakonto**: Lege einen Benutzernamen und ein
    Passwort an (das ist nicht dein TP-Link-Konto). ONVIF antwortet auf Port
    **2020**.
  - **Reolink**: ONVIF ist bei den meisten Modellen standardmäßig an (Port
    **8000**); bei neuer Firmware prüfe **Einstellungen** → **Netzwerk** →
    **Erweitert** → **Servereinstellungen**. Nutze einen Benutzer der Kamera.
  - **Hikvision**: auf der Weboberfläche der Kamera **Konfiguration** →
    **Netzwerk** → **Erweiterte Einstellungen** → **Integrationsprotokoll**:
    Aktiviere **Open Network Video Interface** und lege dort einen
    ONVIF-Benutzer an (das ist eine eigene Benutzerliste).
  - **Dahua, Amcrest**: **Einstellungen** → **Netzwerk** → **Zugangsplattform**
    (oder **ONVIF**): Aktiviere sie; die Benutzer der Kamera funktionieren.
  - Andere Marken: Suche in den Netzwerkeinstellungen nach „ONVIF“.
- Für die Erkennungen: Aktiviere sie in der Kamera selbst (Bewegung, Person,
  Linienüberschreitung…). Manche Marken melden sie über ONVIF nur, wenn sie mit
  einer Aktion verknüpft sind, etwa „Überwachungszentrale benachrichtigen“ bei
  Hikvision.

## Einrichtung

1. Installiere die Integration aus dem Gladys-Katalog.
2. Öffne ihre **Konfiguration**:
   - **Benutzername** und **Passwort**: das ONVIF-Konto deiner Kameras.
   - **Kamera-Adressen**: nur für Kameras, die nicht automatisch gefunden
     werden, durch Kommas getrennt, mit `:Port`, wenn ONVIF nicht auf Port 80
     läuft (zum Beispiel `192.168.1.20, 192.168.1.21:2020`).
   - **Weitere Konten (optional)**: Wenn deine Kameras nicht dasselbe Konto
     haben, füge bis zu zwei weitere hinzu. Jede Kamera wird der Reihe nach mit
     den Konten probiert und behält das akzeptierte.
   - **Bildaktualisierung**: wie oft das Bild jeder Kamera an Gladys gesendet
     wird, von 10 Sekunden bis 15 Minuten (standardmäßig 1 Minute).
   - **Bewegungsdauer**: wie lange sich eine motorisierte Kamera bei einem
     Tippen dreht oder zoomt, wenn kein Stopp folgt (standardmäßig 1 Sekunde).
   - **Sprache der Namen**: Englisch, Französisch, Deutsch oder Spanisch
     (standardmäßig Französisch), für die Namen, die den Funktionen beim
     Hinzufügen einer Kamera gegeben werden.
3. Öffne den Tab **Entdecken** der Integration: Die Kameras erscheinen, mit
   Marke und Modell. Füge die gewünschten hinzu.
4. Die Schaltfläche **Kameras suchen** der Konfiguration sucht erneut,
   probiert die Konten erneut und zeigt, was jede Kamera bietet (PTZ,
   Positionen, Ereignisse) und welche Adressen das Konto abgelehnt haben.

Eine Kamera, die ein Konto ablehnt, wird damit erst wieder gefragt, wenn du
die Konten änderst oder **Kameras suchen** startest: Viele Kameras sperren ein
Konto nach einigen falschen Passwörtern.

## Die Geräte in Gladys

Ein Gerät pro Kamera (ein Rekorder oder eine Kamera mit mehreren Objektiven
ergibt ein Gerät pro Videokanal), benannt nach Marke und Modell. Seine
Funktionen:

- **Bild**: das Kamerabild, im gewählten Takt an Gladys gesendet, plus ein
  frisches einige Sekunden nach einer Erkennung oder einer Bewegung. Es
  erscheint im Kamera-Widget von Gladys, und die Szenen-Aktion
  „Kameraaufnahme senden“ holt ein frisches. Die Bilder werden verkleinert, damit sie in die
  150 KB passen, die Gladys annimmt (höchstens 1280 Pixel breit).
- **Kamerabewegung (PTZ)**, für motorisierte Kameras: Links, Rechts, Hoch,
  Runter, Vergrößern, Verkleinern, nur die, die die Kamera kann. Eine Bewegung
  dauert, solange du die Schaltfläche in Gladys gedrückt hältst, und hält nach
  der **Bewegungsdauer** von selbst an.
- **Gespeicherte Position**, für motorisierte Kameras: die in der Kamera-App
  gespeicherten Positionen, mit ihren Namen. Die Integration liest sie alle
  15 Minuten und bei jeder Suche neu: Eine neue oder umbenannte Position erscheint
  von selbst.
- Ein Sensor pro Erkennung, die die Kamera meldet: **Bewegungserkennung**,
  **Personenerkennung**, **Fahrzeugerkennung**, **Tiererkennung**,
  **Linienüberschreitung**, **Einbruchserkennung** (1 = erkannt) und
  **Manipulation**. Eine Erkennung, die die Kamera erst später meldet, wird
  dann hinzugefügt: Gladys bietet im Tab Entdecken an, das Gerät zu
  aktualisieren.

## Dashboard-Widget

**ONVIF-Kamera**: das Kamerabild mit der Aufnahmezeit, was die Kamera gerade
erkennt, und bis zu vier Schaltflächen. Seine Einstellungen:

- **Kamera**: die anzuzeigende Kamera.
- **Schaltflächen**: **Links, hoch, runter, rechts** (standardmäßig), **Zoom
  und zwei Positionen**, **Vier Positionen** oder **Keine Schaltfläche**. Ein
  Tippen bewegt die Kamera für die Bewegungsdauer oder zur Position, und das
  Widget kommt mit der neuen Ansicht zurück.
- **Positions-Schaltflächen**: die Namen der anzuzeigenden Positionen, durch
  Kommas getrennt; leer für die ersten.

## Szenen

### Auslöser

**Erkennung einer ONVIF-Kamera**: Eine Kamera beginnt etwas zu erkennen.
Filter: **Kamera** und **Erkennung**: **Bewegung**, **Person**, **Fahrzeug**,
**Tier**, **Linienüberschreitung**, **Einbruch**, **Manipulation**,
**Geräusch**, **Türklingel gedrückt** (zum Beispiel die Taste einer
Reolink-Türklingel). Lass einen Filter leer für alle. Variablen: die Erkennung
(`motion`, `person`…) und der Name der ausgelösten Kameraregel, wenn sie einen
liefert. Ein Ereignis pro Beginn einer Erkennung, nie eines pro Sekunde.

### Aktionen

- **Kamera auf gespeicherte Position fahren**: richtet die Kamera auf eine
  ihrer gespeicherten Positionen aus, angegeben mit ihrem Namen (wie in der
  Kamera-App) oder ihrer Nummer. Ausgabe: die erreichte Position.
- **Kamera bewegen**: dreht oder zoomt die Kamera in eine Richtung (**Links**,
  **Rechts**, **Hoch**, **Runter**, **Vergrößern**, **Verkleinern**) für 1 bis
  10 Sekunden und hält sie dann an.

Für ein Bild in einer Nachricht nutze die Gladys-Aktion **Kameraaufnahme
senden**:
Diese Aktion fragt die Integration nach einem frischen Bild.

### Szenen-Ideen

- Nachts, wenn die Gartenkamera eine Person erkennt, ihr Bild an dein Handy
  senden und die Außenbeleuchtung einschalten.
- Wenn alle das Haus verlassen, die Wohnzimmerkamera auf ihre Position „Tür“
  richten; wenn die erste Person zurückkommt, auf ihre Position „Wand“.
- Wenn die Reolink-Türklingel gedrückt wird, ihr Bild senden und „Jemand ist
  an der Tür“ über die Lautsprecher ansagen.

## Fehlerbehebung

- **Keine Kamera im Tab Entdecken**: Prüfe, ob ONVIF aktiviert ist, und
  starte dann **Kameras suchen**. Manche Kameras antworten der Erkennung nur
  über die Multicast-Adresse, die Gladys aus seiner Sandbox nicht nutzen kann:
  Gib ihre Adresse unter **Kamera-Adressen** ein (mit `:2020` für Tapo,
  `:8000` für Reolink).
- **„Konto abgelehnt“**: Der ONVIF-Benutzer ist oft ein eigenes Konto
  (Tapo-Kamerakonto, Hikvision-ONVIF-Benutzer). Prüfe es, speichere die
  Konfiguration und starte dann **Kameras suchen**.
- **Kein Bild**: Die Integration nutzt zuerst die Schnappschuss-Adresse der
  Kamera, dann ein Bild ihres Videostreams (RTSP); beide brauchen das Konto.
- **Keine Erkennung**: Aktiviere die Erkennung in der Kamera und verknüpfe
  sie bei Hikvision mit „Überwachungszentrale benachrichtigen“. Die Kamera muss
  ONVIF-Ereignisabonnements (PullPoint) unterstützen: **Kameras suchen** zeigt
  dann „Ereignisse“ an.
- **Die Kamera dreht sich zu weit oder nicht genug**: Ändere die
  **Bewegungsdauer**.
- Die Protokolle der Integration sagen mehr: **Integrationen** → **ONVIF** →
  **Protokolle**.

## Grenzen

- Bilder, kein Video: höchstens ein Bild alle 10 Sekunden (Gladys nimmt 12
  pro Minute und Kamera an), auf 1280 Pixel Breite verkleinert.
- Die Ereignisse werden von der Integration bei der Kamera abgeholt (sie kann
  sie in ihrer Sandbox nicht von der Kamera empfangen): Eine Erkennung kommt
  innerhalb von ein bis zwei Sekunden in Gladys an.
- Eine Bewegung nach der anderen, mit halber Geschwindigkeit. Positionen
  werden aufgerufen, nicht angelegt: Speichere sie in der Kamera-App.
- Kameras, die nur den neueren ONVIF-Mediendienst sprechen (Profile T ohne
  Profile S), werden noch nicht unterstützt.
- Geräusch und Türklingel sind nur Szenen-Auslöser, ohne Sensor.
- Ohne echte Kamera entwickelt (siehe oben): Rückmeldungen willkommen.
