// Phone layout (< 720px) vs tabbed layout (720px+). Must match the breakpoint in styles.css.
const mq = matchMedia('(max-width: 719.98px)');

export const isPhone = () => mq.matches;
export const onLayoutChange = (fn) => mq.addEventListener('change', () => fn(mq.matches));

// Website-style layout (1200px+): mode chips, tab-style language row, panel language picker.
const webMq = matchMedia('(min-width: 1200px)');
export const isWeb = () => webMq.matches;
export const isRail = () => matchMedia('(min-width: 1024px) and (max-width: 1199.98px)').matches;
