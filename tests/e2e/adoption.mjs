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
}
