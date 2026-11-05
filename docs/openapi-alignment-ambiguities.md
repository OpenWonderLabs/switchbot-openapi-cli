# OpenAPI alignment ambiguities

Evidence is pinned to upstream commit `dc9a6b0e4ad77882c72d186ecd5d134113acdad0`; GitHub's HEAD API still returned that SHA on the continuation check. The CLI separates written contracts, reported payloads, and unresolved server behavior.

- [MindClip](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/dc9a6b0e4ad77882c72d186ecd5d134113acdad0/devices/others/ai-mindclip.md): the CLI, library and MCP now require the documented list/todo/date/week query fields; missing fields fail before HTTP rather than relying on an unverified server default. Extra language/time/folder/category filters, legacy numeric bounds and completed/category value meanings still require upstream confirmation; mock responses do not establish them.
- [Curtain and Blind Tilt](https://github.com/OpenWonderLabs/SwitchBotAPI/tree/dc9a6b0e4ad77882c72d186ecd5d134113acdad0/devices/curtains-blinds): scalar Curtain position, Blind Tilt/Roller Shade on/off, and fan toggle support are not tightened without pinned evidence. The documented spaced Blind Tilt form `up; 36` is accepted and normalized to `up;36`.
- [Robot vacuums](https://github.com/OpenWonderLabs/SwitchBotAPI/tree/dc9a6b0e4ad77882c72d186ecd5d134113acdad0/devices/robot-vacuum): volume descriptions disagree between 0–100 and 1–100, so no new rejection rule is inferred from that contradiction. The independently documented K11/K20 `changeParam.waterLevel` contract is enforced without widening `startClean`.
- [Keypad Vision](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/dc9a6b0e4ad77882c72d186ecd5d134113acdad0/devices/locks-security/keypad-vision.md) and [Keypad Vision Pro](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/dc9a6b0e4ad77882c72d186ecd5d134113acdad0/devices/locks-security/keypad-vision-pro.md) explicitly define name, four passcode types, 6–12 digits, and ten-digit scheduled timestamps for `timeLimit`/`disposable`. Those model-specific rules are now enforced; asynchronous webhook completion is not inferred from POST acceptance.
- [Lock Vision](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/dc9a6b0e4ad77882c72d186ecd5d134113acdad0/devices/locks-security/lock-vision.md) has an object template, not the Keypad field-constraint table. The CLI validates the object shape without imposing undocumented Keypad password/type/timestamp restrictions. Destructive approval remains mandatory. Server field constraints and completion semantics still require official evidence.
- [Presence Sensor](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/dc9a6b0e4ad77882c72d186ecd5d134113acdad0/devices/sensors/presence-sensor.md) says `Detected`, while [contributor hsakoh's reported V1.1 payload](https://github.com/OpenWonderLabs/SwitchBotAPI/issues/439#issuecomment-3618879164) shows lowercase `detected`; its webhook separately uses uppercase-valued `detectionState`. The lowercase primary field is retained and raw payloads are not rewritten. This supports that reported firmware, not every region/firmware or a maintainer-confirmed uppercase exclusion; [PR #509](https://github.com/OpenWonderLabs/SwitchBotAPI/pull/509) remains unmerged.
- [AI Art Frame](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/dc9a6b0e4ad77882c72d186ecd5d134113acdad0/devices/others/ai-art-frame.md): the two-source object shape is enforced, but supported URL protocols, MIME types, and base64 formats are not restricted from examples alone.

MindClip help and MCP discovery do not claim undocumented most-recent,
yesterday, completion-state or category defaults. Examples supply explicit
dates and pagination; requiring documented fields does not require a real account.

## Webhook evidence boundaries

- [Presence Sensor](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/dc9a6b0e4ad77882c72d186ecd5d134113acdad0/devices/sensors/presence-sensor.md) uses the Contact Sensor's `WoContact` context identifier in its example. [RGBIC Neon Wire Rope Light](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/dc9a6b0e4ad77882c72d186ecd5d134113acdad0/devices/lighting/rgbic-neon-wire-rope-light.md) uses `RGBICWW Strip Light`. Neither ambiguous example is used to invent a distinct webhook mapping.
- [Battery Circulator Fan](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/dc9a6b0e4ad77882c72d186ecd5d134113acdad0/devices/climate-control/battery-circulator-fan.md) lists `nightStatus` as Integer but samples `"off"`; [Smart Radiator Thermostat](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/dc9a6b0e4ad77882c72d186ecd5d134113acdad0/devices/climate-control/smart-radiator-thermostat.md) lists `mode` as String but samples `1`. Discovery follows the tables and flags these contradictions; it is advisory, not payload validation or coercion.
- Documented webhook identifiers such as `Robot Vacuum Cleaner s20`, `Robot Vacuum Cleaner K20+ Pro`, and `climate Panel` are preserved separately from REST inventory names. No runtime payload is renamed to match the device catalog.

## 2026-11-05 upstream snapshot

The following evidence is pinned to upstream commit
[`fa8f90c`](https://github.com/OpenWonderLabs/SwitchBotAPI/commit/fa8f90c661cfa183d633d87f18c04e0e5059fa74)
([delta from the earlier snapshot](https://github.com/OpenWonderLabs/SwitchBotAPI/compare/dc9a6b0e4ad77882c72d186ecd5d134113acdad0...fa8f90c661cfa183d633d87f18c04e0e5059fa74)).
It supplements, rather than replaces, the historical evidence above.

- [RGBICWW Light Bars](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/fa8f90c661cfa183d633d87f18c04e0e5059fa74/devices/lighting/rgbicww-light-bars.md#L5-L66)
  documents the REST type, commands, and webhook field shape, but not an exact
  webhook `context.deviceType` or attributable event example. No Light Bars
  webhook identifier is registered until upstream supplies that evidence.
- The Light Bars document gives brightness `1–100` for
  `setBrightnessAndTemperature` while showing `0` in its example. Local
  validation accepts `0–100` for compatibility; server acceptance of `0`
  remains unconfirmed. Likewise, local validation accepts any integer `style`
  and an empty `colorList`; neither a style enum nor a minimum list length is
  confirmed server behavior.
- [Outdoor Pan/Tilt Cam
  3K](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/fa8f90c661cfa183d633d87f18c04e0e5059fa74/devices/cameras/outdoor-pantilt-cam-3k.md#L5-L38)
  and [Solar Pan/Tilt Cam
  2K](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/fa8f90c661cfa183d633d87f18c04e0e5059fa74/devices/cameras/solar-pantilt-cam-2k.md#L5-L86)
  expose status `latestImage` URLs with `expireAt` in Unix seconds. A cached
  status can retain a URL after it expires; consumers must use `expireAt`.
  Solar webhook `timeOfSample` is milliseconds, not the status URL expiry
  unit.
