# TMT Chow! / GatePro — reverse-engineered protocol

Source: HAR captures + decompiled Android app `tw.timotion` V3.2.0
(`tw.basicmodule.model.connection.Wbt01Connection`, `...model.command.UARTCommand`).
The connectivity module is an ESP-based **WBT** module (`espressif.home`); the gate
panel behind it is `PS21050D` / `P190U`. Tuya/TUTK in the app are for cameras, not the gate.

## Cloud auth (HTTP)

- `POST https://chowmeet.kaitron.com/__api__/tmt/token`
  - login: `{grant_type:"password", scope:"user", app_type_index:1, username, password}`
  - refresh: `{grant_type:"refresh_token", app_type_index:1, username, refresh_token}`
  - → `{access_token, refresh_token, token_type:"Bearer", expires_in}` (JWT, 24h). Slow (~1.5s).
  - `username` = the Chow! account name (not the e-mail address).
- `GET https://installer.tmt-automation.com/v4.0/user/devices/` → `admin_devices[]`:
  `uuid`, `devies_type`, `iot_endpoint` (…-ats.iot.eu-central-1.amazonaws.com); `custom_info[].display_name` = name.
- `PUT /v4.0/devices/iot/user/certificate/` `{app:1}` → AWS IoT client cert + private key for the account.
- `PUT /v4.0/devices/iot/device/policy/` `{user_certificateArn, uuid, endpoint:"://<endpoint>"}` → attaches cert to the thing.

## Control (AWS IoT MQTT, mqtts 8883, thing name = uuid)

Connect with the provisioned client cert + Amazon Root CA 1. **clientId must be unique**
(the real WBT module connects as clientId == uuid; reusing it kicks the gate offline).

Topics (all under the thing/uuid):

| purpose | topic | direction |
|---|---|---|
| command | `<uuid>/wbt01Rx` | app → device (publish) |
| reply / ACK | `<uuid>/wbt01Tx` | device → app (subscribe) |
| state (idle) | `$aws/things/<uuid>/shadow/get\|update` + `/accepted` | classic Device Shadow |
| live position | `<uuid>/position` | device → app; travel percentage (e.g. `42%`) |

The AWS IoT policy grants the shadow topics and the **exact** `wbt01Tx`/`wbt01Rx` topics,
but denies the `<uuid>/#` wildcard (subscribing to it drops the connection).

### Command payloads (publish to `<uuid>/wbt01Rx`)

- Gate command: `c=<UARTCommand>` — e.g. `c=FULL OPEN`, `c=FULL CLOSE`, `c=STOP`,
  `c=PED OPEN`, `c=PED CLOSE`.
- Status read (no movement): `c=RS` (read system status) or `c=READ STATUS`.
- Set/verify PIN: `pin=<decodedPin>`.
- Others: `scan`, `wifi:…`, `mcu:…`, `ota:…`.

Commands carry **no PIN** — authorization is the per-user AWS IoT cert. PIN is an
in-app authorization check against the shadow's `WBT PIN`.

### Replies (on `<uuid>/wbt01Tx`, plain text)

`ACK PIN`, `NAK PIN`, `ACK FULL OPEN`, `ACK PED OPEN`, `ACK FULL CLOSE`, `ACK RS:<hex,…>`,
`ACK STATUS`, `ACK RESTORE`, `ACK SCAN:…`, `ACK WIFI`, `ACK OTA`, …

### State: the `DEV STATUS` shadow field

`reported.DEV STATUS` = 9 comma-separated hex bytes, e.g. `60,64,AA,00,40,00,00,40,00`.

- byte[1] & 0x7F = **battery %** (0xFF ⇒ not available)
- byte[2] & 0x40 = **operating** (moving) flag
- byte[3] & 0x7F = **position** 0..100 (`>= 95` ⇒ open; `<= 5` ⇒ closed); byte[3] & 0x80 = **open direction**
- byte[6] & 0x7F = second-leaf position on a dual-leaf gate

**The shadow position is stale while the gate travels** — the live percentage arrives on
the dedicated `<uuid>/position` topic, which is the reliable movement source. Movement
direction comes from the live `/position` deltas (monotonic during travel) plus the
optimistic command intent; the gate has settled once the percentage stops changing or
reaches a limit.
- byte[2] (`AA`) & 0x40 = "isOperation" per the app.

Other reported keys: `DEV INFO` (`P190U,PS21050D,V01`), `DEV PARAM` (20 params),
`UART VER`, `WBT VER`, `WBT PIN`, `WIFI SSID`, `IP`, `WiFi MAC`, `Connected`, `Encryption`, `OTA STATE`.

### PIN decode (`WBT PIN` → digits)

Per comma hex byte `b` at index `i`: `x = ~(b & 0xFF)`; digit char = `x+1` if `i` even, `x-1` if odd.

```
# example only — real values redacted
decodePin("<6 comma hex bytes from the shadow>") -> "<6-digit PIN>"
```

## Mapping to Homey `gate_state`

From byte[3]&0x7F (and byte[6] for dual-leaf), with the moving flag:
closed (pos≈0, at rest) · open (pos≥95, at rest) · opening/closing (moving) · stopped (STOP ack / mid at rest).

## Close needs an OPEN pulse first (this controller)

From a resting-open state this controller ACKs a bare `FULL CLOSE` but does not
move. The phone app's close works only as **OPEN then CLOSE**: an `FULL OPEN` pulse
(relay clicks, gate already open so no motion) followed by `FULL CLOSE`. The Homey
app therefore sends the close as the sequence `FULL OPEN` → (1.2s) → `FULL CLOSE`
(and pedestrian-close as `PED OPEN` → `PED CLOSE`). Open/stop/pedestrian-open are
single commands. Relay commands (RELAY1..4) NAK on this gate (normal, non-relay config).
