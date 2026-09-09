export async function runPresentationChecks({ js, check, sleep }) {
  await js(`document.getElementById('btn-journey').click(); document.getElementById('journey-present').click(); true`);
  check('presentation shows named chapters and bounded navigation', await js(`document.querySelectorAll('#present-chapters button').length >= 3 && document.getElementById('present-prev').disabled && !!document.getElementById('present-title').textContent`));
  await js(`document.querySelector('#present-chapters button:last-child').click(); true`);
  check('chapter rail jumps to final chapter', await js(`document.getElementById('present-next').disabled && document.querySelector('#present-chapters button:last-child').getAttribute('aria-current') === 'true'`));
  await js(`document.getElementById('present-restart').click(); document.getElementById('present-play').click(); true`);
  check('play starts and pause cancels playback', await js(`document.getElementById('present-play').getAttribute('aria-pressed') === 'true'`));
  await js(`document.getElementById('present-play').click(); document.getElementById('present-all').click(); true`);
  check('show all clears story focus and pauses playback', await js(`!document.querySelector('#canvas .story-muted') && document.getElementById('present-play').getAttribute('aria-pressed') === 'false'`));
  await js(`document.getElementById('present-exit').click(); true`);
  check('presentation exits cleanly', await js(`document.getElementById('present-overlay').hidden && !document.getElementById('app').classList.contains('presenting')`));
}
