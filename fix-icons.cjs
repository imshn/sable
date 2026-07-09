const h = require('hugeicons-react');
const keys = Object.keys(h);
const find = (keywords) => {
  for (const kw of keywords) {
    const exact = keys.find(k => k.toLowerCase() === kw.toLowerCase() + 'icon');
    if (exact) return exact;
    const numbered = keys.find(k => k.toLowerCase() === kw.toLowerCase() + '01icon' || k.toLowerCase() === kw.toLowerCase() + '02icon');
    if (numbered) return numbered;
  }
  return keys.find(k => k.toLowerCase().includes(keywords[0].toLowerCase()));
}

const map = {
  lock: find(['Lock', 'Lock01']),
  send: find(['Sent', 'Send', 'Send01']),
  back: find(['ArrowLeft', 'ArrowLeft01']),
  check: find(['Tick', 'Tick01', 'Check']),
  checkAll: find(['TickDouble', 'TickDouble01', 'CheckAll']),
  signout: find(['Logout', 'Logout01']),
  clip: find(['Attachment', 'Attachment01']),
  pin: find(['Location01', 'Pin', 'Pin01']),
  mic: find(['Mic', 'Microphone', 'Mic01']),
  micOff: find(['Mute', 'MicOff', 'MicrophoneOff']),
  video: find(['Video', 'Video01']),
  videoOff: find(['VideoOff']),
  phoneEnd: find(['CallEnd', 'CallEnd01']),
  file: find(['File', 'File01']),
  download: find(['Download', 'Download01']),
  x: find(['Cancel', 'Cancel01', 'Close']),
  image: find(['Image', 'Image01']),
  music: find(['MusicNote', 'MusicNote01']),
  forward: find(['ArrowRight', 'ArrowRight01']),
  trash: find(['Delete', 'Delete01', 'Trash']),
  copy: find(['Copy', 'Copy01']),
  chevronL: find(['ArrowLeft', 'ArrowLeft01', 'ChevronLeft']),
  chevronR: find(['ArrowRight', 'ArrowRight01', 'ChevronRight']),
  volume: find(['VolumeHigh', 'Volume']),
  crosshair: find(['Target', 'Target01', 'Crosshair']),
  globe: find(['Globe', 'Earth']),
  users: find(['UserGroup', 'Users']),
  dots: find(['MoreHorizontal', 'Dots']),
  plus: find(['PlusSign', 'Plus']),
  monitor: find(['Computer', 'Monitor', 'Screen']),
  monitorOff: find(['ComputerRemove', 'MonitorRemove']),
  userPlus: find(['UserAdd', 'UserAdd01']),
  sun: find(['Sun', 'Sun01']),
  rotate: find(['Refresh', 'Rotate']),
  reply: find(['MailReply', 'Reply']),
  pen: find(['PencilEdit', 'Edit', 'Pen']),
  crop: find(['Crop']),
  moon: find(['Moon', 'Moon01'])
};

let out = `import React from 'react';\nimport { ${[...new Set(Object.values(map))].join(', ')} } from 'hugeicons-react';\n\n`;
out += `const wrap = (IconComponent) => <IconComponent size={24} strokeWidth={1.8} color="currentColor" />;\n\n`;
out += `export const Icon = {\n`;
for (const [k, v] of Object.entries(map)) {
  out += `  ${k}: wrap(${v}),\n`;
}
out += `};\n`;

require('fs').writeFileSync('src/icons.jsx', out);
console.log('done');
