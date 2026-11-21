/** GALLINAS EXAMPLE. Paste this logic into the PARENT PAGE, not inside its iframes.
 * Preserve the site's real tab navigation. Adjust selectors to its actual DOM.
 * Used ONLY if ACTIONS_MANIFEST.json includes demo.open with option=01/02/03.
 */
export const gallinasHandlers = {
  'demo.open': ({ option }) => {
    if (!['01','02','03'].includes(option)) return { ok:false };
    const tab = document.getElementById(`tab-${option}`);
    if (!tab) return { ok:false }; // Do not invent a parallel navigation system.
    tab.click(); // Exactly the same user-facing action as the existing tab button.
    return { ok:true };
  },
};
