import { h, mount } from '../dom.js';
import { api, describeError } from '../api.js';
import { store } from '../store.js';
import { toWav8k, MicRecorder, uploadPrompt } from '../audio.js';
import { field, check, dataTable, openDialog, select, stateBadge, loadDestinationData, describeDestination, destinationPicker, fmtDuration } from './common.js';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '*', '#'];

export function menusView() {
  const dialogHost = h('div');
  const promptBox = h('section', { class: 'panel', id: 'prompts-panel' });
  const annBox = h('section', { class: 'panel' });
  const ivrBox = h('section', { class: 'panel' });
  let data = { extensions: [], ringGroups: [], timeConditions: [], ivrs: [], announcements: [] };
  let prompts = [];

  async function load() {
    try {
      [data, prompts] = await Promise.all([loadDestinationData(), api('GET', '/pbx/prompts').then((r) => r.prompts)]);
      renderPrompts();
      renderAnn();
      renderIvr();
    } catch (err) {
      mount(promptBox, h('p', { class: 'form-error' }, describeError(err)));
    }
  }

  // --------------------------------------------------------------------- prompts
  function renderPrompts() {
    mount(
      promptBox,
      h('div', { class: 'section-head' }, h('h2', null, 'Audio prompts'),
        h('button', { class: 'btn primary', id: 'add-prompt', onclick: addPrompt }, 'Add prompt')),
      h('p', { class: 'muted small' }, 'Recordings that menus and announcements play to callers. Upload any audio file (WAV, MP3, M4A...) or record with your microphone; it is converted to telephone quality automatically.'),
      dataTable(
        ['Name', 'Length', 'Listen', 'Used', ''],
        prompts.map((p) => [
          h('strong', null, p.name), fmtDuration(Math.round(p.duration_ms / 1000)),
          h('audio', { controls: true, preload: 'none', src: `/api/pbx/prompts/${p.id}/audio`, class: 'player' }),
          p.in_use ? stateBadge('online', 'In use') : '—',
          h('div', { class: 'row-actions' },
            h('button', { class: 'btn small', onclick: () => rename(p) }, 'Rename'),
            h('button', { class: 'btn small danger', onclick: () => remove('prompts', p, `prompt "${p.name}"`) }, 'Delete')),
        ]),
        { empty: 'No prompts yet. Add one, then use it in a menu or announcement.' },
      ),
    );
  }

  function addPrompt() {
    openDialog(dialogHost, {
      title: 'Add audio prompt',
      build: ({ close, showError }) => {
        const name = h('input', { required: true, maxlength: 60, placeholder: 'e.g. Welcome greeting' });
        const file = h('input', { type: 'file', accept: 'audio/*,.wav,.mp3,.m4a,.ogg' });
        const status = h('p', { class: 'muted small', 'aria-live': 'polite' });
        const rec = new MicRecorder();
        let recording = false;
        let recorded = null; // ArrayBuffer of the microphone recording
        const recBtn = h('button', { class: 'btn', type: 'button', id: 'record-prompt' }, 'Record with microphone');
        const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save prompt');

        recBtn.addEventListener('click', async () => {
          try {
            if (!recording) {
              await rec.start();
              recording = true; recorded = null;
              recBtn.textContent = 'Stop recording';
              status.textContent = 'Recording… speak now.';
            } else {
              recorded = await rec.stop();
              recording = false;
              recBtn.textContent = 'Record again';
              status.textContent = 'Recorded. Give it a name and save.';
            }
          } catch (err) {
            recording = false;
            showError(err.name === 'NotAllowedError' ? 'Microphone access was refused. Allow it in the browser, or upload a file instead.' : (err.message || 'Could not record'));
          }
        });

        return h('form', {
          class: 'stack',
          onsubmit: async (e) => {
            e.preventDefault();
            save.disabled = true;
            try {
              let source = recorded;
              if (!source && file.files[0]) source = await file.files[0].arrayBuffer();
              if (!source) throw new Error('Choose an audio file or record something first.');
              status.textContent = 'Converting…';
              const wav = await toWav8k(source);
              status.textContent = 'Uploading…';
              await uploadPrompt(name.value.trim(), wav);
              store.toast('Prompt saved', 'info');
              rec.cancel();
              close();
              await load();
            } catch (err) {
              status.textContent = '';
              showError(err);
            } finally { save.disabled = false; }
          },
        },
        field('Name', name),
        field('Audio file', file, 'WAV, MP3, M4A, OGG ...'),
        h('div', null, 'or ', recBtn), status,
        h('div', { class: 'actions' }, save, h('button', { class: 'btn', type: 'button', onclick: () => { rec.cancel(); close(); } }, 'Cancel')));
      },
    });
  }

  function rename(p) {
    openDialog(dialogHost, {
      title: `Rename "${p.name}"`,
      build: ({ close, showError }) => {
        const name = h('input', { required: true, maxlength: 60, value: p.name });
        return h('form', {
          class: 'stack',
          onsubmit: async (e) => {
            e.preventDefault();
            try { await api('PATCH', `/pbx/prompts/${p.id}`, { name: name.value.trim() }); close(); await load(); } catch (err) { showError(err); }
          },
        }, field('Name', name), h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save'), h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel')));
      },
    });
  }

  // --------------------------------------------------------------- announcements
  function renderAnn() {
    mount(
      annBox,
      h('div', { class: 'section-head' }, h('h2', null, 'Announcements'),
        h('button', { class: 'btn primary', id: 'add-announcement', onclick: () => editAnn(null), disabled: !prompts.length }, 'Add announcement')),
      h('p', { class: 'muted small' }, 'Play a recording, then continue somewhere else or hang up: "we are closed", "this number has changed". Use one as the destination of an inbound route or a business-hours schedule.'),
      dataTable(
        ['Name', 'Plays', 'Then', ''],
        data.announcements.map((a) => [
          h('strong', null, a.name), a.prompt_name, describeDestination(a.next_dest, data),
          h('div', { class: 'row-actions' },
            a.enabled ? null : stateBadge('offline', 'Disabled'),
            h('button', { class: 'btn small', onclick: () => editAnn(a) }, 'Edit'),
            h('button', { class: 'btn small danger', onclick: () => remove('announcements', a, `announcement "${a.name}"`) }, 'Delete')),
        ]),
        { empty: 'No announcements yet.' },
      ),
    );
  }

  function editAnn(a) {
    const creating = !a;
    openDialog(dialogHost, {
      title: creating ? 'Add announcement' : `Edit announcement "${a.name}"`,
      build: ({ close, showError }) => {
        const name = h('input', { required: true, maxlength: 60, value: a?.name || '', placeholder: 'e.g. Closed message' });
        const prompt = select(prompts.map((p) => ({ value: String(p.id), label: p.name })), a ? String(a.prompt_id) : undefined);
        const next = destinationPicker(data, { value: a?.next_dest, allowNone: true, noneLabel: 'Hang up', exclude: a ? `announcement:${a.id}` : null });
        const enabled = h('input', { type: 'checkbox', checked: a ? a.enabled : true });
        return h('form', {
          class: 'stack',
          onsubmit: async (e) => {
            e.preventDefault();
            const body = { name: name.value.trim(), prompt_id: Number(prompt.value), next_dest: next.get(), enabled: enabled.checked };
            try {
              if (creating) await api('POST', '/pbx/announcements', body); else await api('PATCH', `/pbx/announcements/${a.id}`, body);
              close(); await load();
            } catch (err) { showError(err); }
          },
        },
        field('Name', name), field('Plays this prompt', prompt), field('Afterwards', next.el), check(enabled, 'Enabled'),
        h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save'), h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel')));
      },
    });
  }

  // ------------------------------------------------------------------------ menus
  function renderIvr() {
    mount(
      ivrBox,
      h('div', { class: 'section-head' }, h('h2', null, 'Menus (IVR: "press 1 for sales...")'),
        h('button', { class: 'btn primary', id: 'add-ivr', onclick: () => editIvr(null) }, 'Add menu')),
      h('p', { class: 'muted small' }, 'Callers hear a prompt and press a key to be sent somewhere: an extension, a ring group, another menu, a business-hours schedule. Use a menu as the destination of an inbound route; its number can also be dialled internally.'),
      dataTable(
        ['Number', 'Name', 'Prompt', 'Keys', 'No key pressed', ''],
        data.ivrs.map((i) => [
          h('strong', null, i.number), i.name, i.prompt_name || 'none',
          i.options.length ? i.options.map((o) => h('div', null, `${o.digit} → ${describeDestination(o.dest, data)}`)) : 'none',
          `${i.max_repeats}× then ${describeDestination(i.fail_dest, data)}`,
          h('div', { class: 'row-actions' },
            i.enabled ? null : stateBadge('offline', 'Disabled'),
            h('button', { class: 'btn small', onclick: () => editIvr(i) }, 'Edit'),
            h('button', { class: 'btn small danger', onclick: () => remove('ivrs', i, `menu ${i.number}`) }, 'Delete')),
        ]),
        { empty: 'No menus yet.' },
      ),
    );
  }

  function editIvr(i) {
    const creating = !i;
    openDialog(dialogHost, {
      title: creating ? 'Add menu' : `Edit menu ${i.number}`,
      wide: true,
      build: ({ close, showError }) => {
        const f = {
          number: h('input', { required: true, pattern: '[0-9]{3,6}', placeholder: 'e.g. 900', value: i?.number || '', disabled: !creating }),
          name: h('input', { required: true, maxlength: 40, placeholder: 'e.g. Main menu', value: i?.name || '' }),
          prompt: select([{ value: '', label: 'No prompt (silence)' }, ...prompts.map((p) => ({ value: String(p.id), label: p.name }))], i?.prompt_id ? String(i.prompt_id) : ''),
          timeout: h('input', { type: 'number', min: 3, max: 30, value: i?.timeout_secs || 6 }),
          repeats: h('input', { type: 'number', min: 1, max: 5, value: i?.max_repeats || 2 }),
          dial: h('input', { type: 'checkbox', checked: i ? i.allow_extension_dial : false }),
          enabled: h('input', { type: 'checkbox', checked: i ? i.enabled : true }),
        };
        const fail = destinationPicker(data, { value: i?.fail_dest, allowNone: true, noneLabel: 'Hang up' });
        const rows = [];
        const list = h('div', { class: 'stack' });
        const addRow = (opt) => {
          const key = select(KEYS.map((k) => ({ value: k, label: k })), opt?.digit || KEYS.find((k) => !rows.some((r) => r.key.value === k)) || '1');
          const dest = destinationPicker(data, { value: opt?.dest || { type: 'extension', value: data.extensions[0]?.number } });
          const row = { key, dest, el: null };
          row.el = h('div', { class: 'ivr-row' }, h('span', null, 'Press'), key, h('span', null, '→'), dest.el,
            h('button', { class: 'btn small danger', type: 'button', onclick: () => { rows.splice(rows.indexOf(row), 1); row.el.remove(); } }, 'Remove'));
          rows.push(row);
          list.appendChild(row.el);
        };
        (i?.options || []).forEach(addRow);
        return h('form', {
          class: 'stack',
          onsubmit: async (e) => {
            e.preventDefault();
            const body = {
              name: f.name.value.trim(), prompt_id: f.prompt.value ? Number(f.prompt.value) : null,
              timeout_secs: Number(f.timeout.value) || 6, max_repeats: Number(f.repeats.value) || 2,
              options: rows.map((r) => ({ digit: r.key.value, dest: r.dest.get() })),
              fail_dest: fail.get(), allow_extension_dial: f.dial.checked, enabled: f.enabled.checked,
            };
            try {
              if (creating) await api('POST', '/pbx/ivrs', { number: f.number.value.trim(), ...body }); else await api('PATCH', `/pbx/ivrs/${i.id}`, body);
              store.toast('Menu saved', 'info');
              close(); await load();
            } catch (err) { showError(err); }
          },
        },
        h('div', { class: 'form-grid' }, field('Number', f.number, creating ? 'Dial this to try the menu.' : null), field('Name', f.name)),
        field('Prompt played to callers', f.prompt),
        h('div', null, h('strong', null, 'Keys'), list, h('button', { class: 'btn small', type: 'button', id: 'add-ivr-key', onclick: () => addRow(null) }, 'Add a key')),
        h('div', { class: 'form-grid' }, field('Wait for a key (seconds)', f.timeout), field('Play the menu this many times', f.repeats)),
        field('If the caller presses nothing (after the last repeat)', fail.el),
        check(f.dial, 'Let callers dial an extension number directly', '(they type the extension; single keys above are then confirmed after a short pause)'),
        check(f.enabled, 'Enabled'),
        h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save'), h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel')));
      },
    });
  }

  async function remove(kind, item, text) {
    if (!window.confirm(`Delete ${text}?`)) return;
    try {
      await api('DELETE', `/pbx/${kind}/${item.id}`);
      store.toast('Deleted', 'info');
      await load();
    } catch (err) { store.toast(describeError(err)); }
  }

  load();
  return { el: h('div', { class: 'stack' }, h('h1', null, 'Menus & audio'), ivrBox, annBox, promptBox, dialogHost), destroy() {} };
}
