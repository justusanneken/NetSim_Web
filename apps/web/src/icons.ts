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

export const ICON_FALLBACK = ['M6 6h36v36H6z', 'M6 6l36 36M42 6L6 42'];

export const DEVICE_COLORS: Partial<Record<DeviceType, string>> = {
  pc: '#2f6fed',
  'switch-l2': '#1a8f6f',
  hub: '#b7791f',
  router: '#d9480f',
  laptop: '#2f6fed',
  server: '#7048e8',
};
