import * as h from 'hugeicons-react';
import fs from 'fs';

const find = (...names) => {
  for (const name of names) {
    if (h[name]) return name;
  }
  return 'Cancel01Icon'; // fallback
}

const map = {
  lock: find('LockIcon', 'Lock01Icon', 'BookmarkBlock01Icon'),
  send: find('SentIcon', 'SendIcon', 'Send01Icon'),
  back: find('ArrowLeft01Icon'),
  check: find('Tick01Icon', 'CheckIcon'),
  checkAll: find('TickDouble01Icon', 'CheckAllIcon'),
  signout: find('Logout01Icon', 'LogoutIcon'),
  clip: find('Attachment01Icon', 'AttachmentIcon'),
  pin: find('Location01Icon', 'PinIcon'),
  mic: find('Mic01Icon', 'Microphone01Icon'),
  micOff: find('MicOff01Icon', 'MicrophoneOff01Icon', 'MuteIcon'),
  video: find('Video01Icon', 'CameraVideoIcon'),
  videoOff: find('VideoOffIcon', 'CameraVideoOffIcon'),
  phoneEnd: find('CallEnd01Icon', 'CallSlashIcon'),
  file: find('File01Icon', 'DocumentIcon'),
  download: find('Download01Icon', 'DownloadIcon'),
  x: find('Cancel01Icon', 'CloseIcon'),
  image: find('Image01Icon', 'PhotographIcon'),
  music: find('MusicNote01Icon', 'MusicIcon'),
  forward: find('ArrowRight01Icon', 'ForwardIcon'),
  trash: find('Delete01Icon', 'TrashIcon'),
  copy: find('Copy01Icon', 'CopyIcon'),
  chevronL: find('ArrowLeft01Icon', 'ChevronLeftIcon'),
  chevronR: find('ArrowRight01Icon', 'ChevronRightIcon'),
  volume: find('VolumeHighIcon', 'VolumeIcon'),
  crosshair: find('Target01Icon', 'CrosshairIcon'),
  globe: find('GlobeIcon', 'EarthIcon'),
  users: find('UserGroupIcon', 'UsersIcon'),
  dots: find('MoreHorizontalIcon', 'DotsIcon'),
  plus: find('PlusSignIcon', 'PlusIcon'),
  monitor: find('ComputerScreenShareIcon', 'ComputerIcon', 'Monitor01Icon'),
  monitorOff: find('ComputerRemoveIcon', 'MonitorOffIcon', 'Cancel01Icon'),
  userPlus: find('UserAdd01Icon', 'UserPlusIcon'),
  sun: find('Sun01Icon', 'SunIcon'),
  rotate: find('RefreshIcon', 'RotateIcon'),
  reply: find('MailReply01Icon', 'ReplyIcon'),
  pen: find('PencilEdit01Icon', 'Edit01Icon', 'PenIcon'),
  crop: find('CropIcon'),
  moon: find('Moon01Icon', 'MoonIcon')
};

const uniqueIcons = [...new Set(Object.values(map))];

let out = `import React from 'react';\nimport { ${uniqueIcons.join(', ')} } from 'hugeicons-react';\n\n`;
out += `const wrap = (IconComponent) => <IconComponent size={24} strokeWidth={1.8} color="currentColor" />;\n\n`;
out += `export const Icon = {\n`;
for (const [k, v] of Object.entries(map)) {
  out += `  ${k}: wrap(${v}),\n`;
}
out += `};\n`;

fs.writeFileSync('src/icons.jsx', out);
console.log('icons.jsx generated successfully.');
