const svg = (paths, extra = {}) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...extra}>
    {paths}
  </svg>
)

export const Icon = {
  lock: svg(<><rect x="4.5" y="10.5" width="15" height="10" rx="2.5" /><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" /></>),
  send: svg(<><path d="M5 12h13" /><path d="m12 5 7 7-7 7" /></>),
  back: svg(<><path d="M19 12H6" /><path d="m12 19-7-7 7-7" /></>),
  check: svg(<path d="m4 12.5 5 5L20 6.5" />, { strokeWidth: 2.2 }),
  checkAll: svg(<><path d="m2 13 4.5 4.5L15 9" /><path d="m10 13.5 4 4L22.5 9" /></>, { strokeWidth: 2.2 }),
  signout: svg(<><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="m10 17-5-5 5-5" /><path d="M5 12h10" /></>),
  clip: svg(<path d="m21 12-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8L13 4.4a3.7 3.7 0 0 1 5.2 5.2L10 17.8a1.85 1.85 0 0 1-2.6-2.6L15 7.5" />),
  pin: svg(<><path d="M12 21s-7-5.3-7-11a7 7 0 0 1 14 0c0 5.7-7 11-7 11Z" /><circle cx="12" cy="10" r="2.5" /></>),
  mic: svg(<><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" /></>),
  micOff: svg(<><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" /><path d="m4 4 16 16" /></>),
  video: svg(<><rect x="3" y="7" width="12" height="10" rx="2.5" /><path d="m15 11 6-3.5v9L15 13" /></>),
  videoOff: svg(<><rect x="3" y="7" width="12" height="10" rx="2.5" /><path d="m15 11 6-3.5v9L15 13" /><path d="m4 4 16 16" /></>),
  phoneEnd: svg(<path d="M4 15c5-4.5 11-4.5 16 0l-2.5 3.5c-1-.5-2.5-1.5-3-2.5v-2.5c-1.5-.5-4.5-.5-5 0V16c-.5 1-2 2-3 2.5Z" />, { fill: 'currentColor', stroke: 'none' }),
  file: svg(<><path d="M6 3h8l4 4v14H6Z" /><path d="M14 3v4h4" /></>),
  download: svg(<><path d="M12 4v11" /><path d="m7 11 5 5 5-5" /><path d="M5 20h14" /></>),
  x: svg(<><path d="m6 6 12 12" /><path d="m18 6-12 12" /></>),
  image: svg(<><rect x="3.5" y="5" width="17" height="14" rx="2.5" /><circle cx="9" cy="10" r="1.6" /><path d="m4 17 5-4.5 3.5 3 3-2.5 4.5 4" /></>),
  music: svg(<><path d="M9 18V6l10-2v12" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="16.5" cy="16" r="2.5" /></>),
  forward: svg(<><path d="m14 5 6 6-6 6" /><path d="M20 11H9a5 5 0 0 0-5 5v3" /></>),
  trash: svg(<><path d="M4.5 7h15" /><path d="M9 7V4.5h6V7" /><path d="M6.5 7 8 20h8l1.5-13" /></>),
  copy: svg(<><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></>),
  chevronL: svg(<path d="m14.5 5-7 7 7 7" />, { strokeWidth: 2.2 }),
  chevronR: svg(<path d="m9.5 5 7 7-7 7" />, { strokeWidth: 2.2 }),
  volume: svg(<><path d="M4 9.5v5h3.5L12 19V5L7.5 9.5Z" /><path d="M15.5 9a4.5 4.5 0 0 1 0 6" /></>),
  crosshair: svg(<><circle cx="12" cy="12" r="7" /><path d="M12 3v3" /><path d="M12 18v3" /><path d="M3 12h3" /><path d="M18 12h3" /></>),
  globe: svg(<><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17" /><path d="M12 3.5c2.7 2.3 4 5.2 4 8.5s-1.3 6.2-4 8.5c-2.7-2.3-4-5.2-4-8.5s1.3-6.2 4-8.5Z" /></>),
  users: svg(<><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8" /><path d="M15.5 5.2a3.2 3.2 0 0 1 0 5.6" /><path d="M17.5 14.6c1.6.7 2.7 2.1 3 4.4" /></>),
  dots: svg(<><circle cx="12" cy="5.5" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="12" cy="18.5" r="1.4" /></>, { fill: 'currentColor', stroke: 'none' }),
  plus: svg(<><path d="M12 5v14" /><path d="M5 12h14" /></>),
  monitor: svg(<><rect x="3" y="4.5" width="18" height="12.5" rx="2" /><path d="M9 21h6" /><path d="M12 17v4" /></>),
  monitorOff: svg(<><rect x="3" y="4.5" width="18" height="12.5" rx="2" /><path d="M9 21h6" /><path d="M12 17v4" /><path d="m5 6.5 14 8.5" /></>),
  userPlus: svg(<><circle cx="10" cy="8" r="3.2" /><path d="M4.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8" /><path d="M18 7v6" /><path d="M15 10h6" /></>),
}
