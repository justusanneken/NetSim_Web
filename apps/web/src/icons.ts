import type { DeviceType } from '@netsim/engine';

/** Eigene Geräte-Icons (48×48, Strichgrafik) – als SVG-Pfade für Palette UND Konva. */
export const ICON_PATHS: Partial<Record<DeviceType, string[]>> = {
  pc: ['M7 7h34v24H7z', 'M11 11h26v16H11z', 'M20 31v5h-8v4h24v-4h-8v-5'],
  'switch-l2': [
    'M4 14h40v20H4z',
    'M9 21h5v6H9zM17 21h5v6h-5zM25 21h5v6h-5zM33 21h5v6h-5z',
    'M9 31h30',
  ],
  hub: [
    'M4 16h40v16H4z',
    'M10 22h4v4h-4zM18 22h4v4h-4zM26 22h4v4h-4zM34 22h4v4h-4z',
    'M24 16V9M20 9h8',
  ],
};

ICON_PATHS.laptop = ['M10 10h28v20H10z', 'M14 14h20v12H14z', 'M4 34h40l-4 5H8z'];
ICON_PATHS.server = [
  'M12 6h24v12H12z',
  'M12 20h24v12H12z',
  'M12 34h24v8H12z',
  'M16 12h3M16 26h3M16 38h3',
];
ICON_PATHS.router = [
  'M8 24a16 16 0 1 0 32 0a16 16 0 1 0 -32 0',
  'M24 12v24M12 24h24',
  'M20 16l4-4 4 4M20 32l4 4 4-4M16 20l-4 4 4 4M32 20l4 4-4 4',
];

ICON_PATHS['switch-l3'] = [
  'M4 14h40v20H4z',
  'M9 21h5v6H9zM17 21h5v6h-5zM25 21h5v6h-5zM33 21h5v6h-5z',
  'M24 14V8M18 11l6-5 6 5',
];

// Phase 5
ICON_PATHS.tablet = ['M12 6h24v36H12z', 'M16 10h16v24H16z', 'M22 38h4'];
ICON_PATHS.smartphone = ['M17 5h14v38H17z', 'M20 9h8v26h-8z', 'M22 39h4'];
ICON_PATHS.printer = ['M13 17V7h22v10', 'M8 17h32v16H8z', 'M13 28h22v14H13z', 'M17 34h14M17 38h10'];
ICON_PATHS.ap = [
  'M12 34h24v6H12z',
  'M24 34v-4',
  'M20 28a5 5 0 0 1 8 0',
  'M16 23a11 11 0 0 1 16 0',
  'M11 18a18 18 0 0 1 26 0',
];
ICON_PATHS.wlc = [
  'M6 28h36v12H6z',
  'M12 34h4M20 34h4',
  'M16 22a11 11 0 0 1 16 0',
  'M11 17a18 18 0 0 1 26 0',
  'M24 28v-3',
];
ICON_PATHS.firewall = [
  'M6 10h36v28H6z',
  'M6 19h36M6 28h36',
  'M18 10v9M30 10v9M12 19v9M24 19v9M36 19v9M18 28v10M30 28v10',
];
ICON_PATHS.cloud = ['M14 37a8 8 0 0 1-1-16 11 11 0 0 1 21-3 9 9 0 0 1 2 19z'];
ICON_PATHS['dsl-modem'] = [
  'M6 20h36v18H6z',
  'M12 29h4M20 29h4',
  'M32 26v6M36 24v8',
  'M14 20l-4-10',
];
ICON_PATHS['cable-modem'] = [
  'M6 20h36v18H6z',
  'M12 29h4',
  'M26 29a4 4 0 1 0 8 0a4 4 0 1 0 -8 0',
  'M32 20V10',
];
ICON_PATHS['iot-sensor'] = ['M20 6h8v22a8 8 0 1 1 -8 0z', 'M24 12v20', 'M32 12h6M32 18h4'];
ICON_PATHS['iot-actuator'] = [
  'M10 12h28v24H10z',
  'M18 25a6 6 0 1 0 12 0a6 6 0 1 0 -12 0',
  'M24 17v8',
];
ICON_PATHS.sbc = [
  'M6 12h36v26H6z',
  'M12 18h10v8H12z',
  'M28 18h8v4h-8z',
  'M12 32h24',
  'M10 38v4M18 38v4M26 38v4M34 38v4',
];

export const ICON_FALLBACK = ['M6 6h36v36H6z', 'M6 6l36 36M42 6L6 42'];

export const DEVICE_COLORS: Partial<Record<DeviceType, string>> = {
  pc: '#2f6fed',
  'switch-l2': '#1a8f6f',
  'switch-l3': '#0b7285',
  hub: '#b7791f',
  router: '#d9480f',
  laptop: '#2f6fed',
  server: '#7048e8',
  tablet: '#2f6fed',
  smartphone: '#2f6fed',
  printer: '#5c6b7a',
  ap: '#0c8599',
  wlc: '#1864ab',
  firewall: '#c92a2a',
  cloud: '#4c6ef5',
  'dsl-modem': '#868e96',
  'cable-modem': '#868e96',
  'iot-sensor': '#2b8a3e',
  'iot-actuator': '#e67700',
  sbc: '#5f3dc4',
};
