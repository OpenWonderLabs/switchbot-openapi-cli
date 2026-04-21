/**
 * Single source of truth for SwitchBot product identity.
 *
 * Consumed by:
 *   - `program.description()` / `--help`   (via PRODUCT_TAGLINE in src/index.ts)
 *   - `--help --json` root                  (via src/utils/help-json.ts)
 *   - `switchbot capabilities` / `--json`   (identity block)
 *   - `switchbot agent-bootstrap --json`    (identity block)
 *
 * Keeping this in one file prevents drift between those four surfaces.
 *
 * IMPORTANT: the SwitchBot CLI only talks to the SwitchBot Cloud API over
 * HTTPS. It does NOT drive BLE radios directly — BLE-only devices are
 * reached by going through a SwitchBot Hub, which the Cloud API already
 * handles transparently. Please do not reintroduce the word "BLE" into the
 * tagline / README: it is misleading for AI agents reading `--help`.
 */
export const IDENTITY = {
  product: 'SwitchBot',
  domain: 'IoT smart home device control',
  vendor: 'Wonderlabs, Inc.',
  apiVersion: 'v1.1',
  apiDocs: 'https://github.com/OpenWonderLabs/SwitchBotAPI',
  // Product category keywords. AI agents scan these to judge scope
  // ("does SwitchBot control door locks? air conditioners?") without
  // parsing the full device catalog.
  productCategories: [
    'lights (bulbs / strips / color)',
    'locks / keypads',
    'curtains / blinds / shades',
    'sensors (motion / contact / climate / water-leak)',
    'plugs / strips',
    'bots / mechanical pushers',
    'robot vacuums',
    'IR appliances via Hub (TV / AC / fan / projector)',
  ] as const,
  deviceCategories: {
    physical:
      'Wi-Fi-connected and Hub-mediated devices — controlled via Cloud API (CLI does not drive BLE directly)',
    ir: 'IR remote devices learned by a SwitchBot Hub (TV, AC, fan, etc.)',
  },
  constraints: {
    quotaPerDay: 10000,
    hubRequiredForBle: true,
    transport: 'Cloud API v1.1 (HTTPS)',
    authMethod: 'HMAC-SHA256 token+secret',
  },
  agentGuide: 'docs/agent-guide.md',
} as const;

/**
 * One-line product description used for `program.description()` (the first
 * line an AI agent sees when running `switchbot --help`).
 *
 * Structure: "SwitchBot smart home CLI — <product categories> via <transport>;
 *             <verbs: scenes, events, MCP>." Keep categories in sync with
 * IDENTITY.productCategories above.
 */
export const PRODUCT_TAGLINE =
  'SwitchBot smart home CLI — control lights, locks, curtains, sensors, plugs, ' +
  'and IR appliances (TV/AC/fan) via Cloud API v1.1; run scenes, stream real-time ' +
  'events, and integrate AI agents via MCP.';
