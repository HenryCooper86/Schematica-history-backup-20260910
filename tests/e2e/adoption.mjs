export async function runAdoptionChecks({ js, key, check, sleep }) {
  await key('/', 'Slash', 191);
  await js(`const q = document.getElementById('board-search'); q.value = 'ESP32'; q.dispatchEvent(new Event('input')); true`);
  await key('Enter', 'Enter', 13);
  await js(`document.getElementById('explore-close').click(); document.getElementById('btn-journey').click(); document.getElementById('journey-add').click(); true`);
  await js(`document.querySelector('.journey-step:nth-last-child(2) [data-jact="link"]').click(); true`);
  check('journey step links to selected parts', await js(`document.querySelector('.journey-step:nth-last-child(2)').textContent.includes('Linked to parts and wires')`));
  await js(`document.querySelector('.journey-step:nth-last-child(2) [data-jact="go"]').click(); true`);
  check('linked journey Go highlights exact targets', await js(`document.querySelector('#canvas .node[data-id="n5"]').classList.contains('story-match') && document.querySelectorAll('#canvas .node.story-match').length === 1`));
  await sleep(650);
  await js(`document.querySelector('.journey-step:nth-last-child(2) [data-jact="unlink"]').click(); true`);
  check('camera-only action removes linked highlighting', await js(`!document.querySelector('#canvas .story-match') && !document.querySelector('.journey-step:nth-last-child(2) [data-jact="unlink"]')`));
  await js(`document.getElementById('undo').click(); document.querySelector('.journey-step:nth-last-child(2) [data-jact="go"]').click(); true`);
  check('undo restores journey targets', await js(`!!document.querySelector('#canvas .story-match')`));
  await js(`document.getElementById('journey-present').click(); document.getElementById('present-exit').click(); true`);
  check('leaving Present clears story highlighting', await js(`!document.querySelector('#canvas .story-match, #canvas .story-muted')`));
  await js(`(async () => { const {buildHTML} = await import('/src/html-export.js'); const {EXAMPLES} = await import('/src/examples.js'); const html = buildHTML(EXAMPLES.find(e => e.id === 'weather-station').doc); location.href = URL.createObjectURL(new Blob([html], {type:'text/html'})); return true; })()`);
  await sleep(450);
  check('offline HTML viewer loads its embedded board', await js(`document.querySelectorAll('svg .node').length === 8 && !!document.getElementById('chapters')`));
  await js(`document.getElementById('search').value = 'ESP32'; document.getElementById('search').dispatchEvent(new Event('input')); document.getElementById('results').value = 'n5'; document.getElementById('results').dispatchEvent(new Event('change')); document.getElementById('bus').value = 'i2c'; document.getElementById('bus').dispatchEvent(new Event('change')); document.getElementById('connections').value = 'neighbors'; document.getElementById('connections').dispatchEvent(new Event('change')); true`);
  check('offline search and bus tracing use embedded connectivity', await js(`document.querySelectorAll('.wire.focused').length === 1 && document.querySelectorAll('.node.focused').length === 2`));

}
