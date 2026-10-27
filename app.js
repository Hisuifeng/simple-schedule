(function () {
  'use strict';

  var STORAGE_KEY = 'timetable.v3';
  var DEFAULT_DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  var DEFAULT_SETTINGS = {
    morningStart: '08:00',
    morningEnd: '12:00',
    afternoonStart: '14:00',
    afternoonEnd: '18:00',
    periodMinutes: 45,
    breakMinutes: 10,
    extraBreaks: {},
    hideEmptyPeriods: true
  };

  /* 深色扁平色板：配白色文字 */
  var PALETTE = [
    '#1d4ed8', '#6d28d9', '#be185d', '#b91c1c',
    '#c2410c', '#a16207', '#15803d', '#0f766e',
    '#0e7490', '#4338ca', '#9333ea', '#475569'
  ];

  var state = {
    days: DEFAULT_DAYS.slice(),
    hiddenDays: [],
    settings: Object.assign({}, DEFAULT_SETTINGS, { extraBreaks: {} }),
    periods: [],
    courses: {},
    colors: {}
  };

  var dragEnabled = false;
  var dragSource = null;

  var editTarget = null;
  var editColorPicked = null;
  var draftExtras = {};

  function $(id) { return document.getElementById(id); }
  function cellKey(day, period) { return day + '-' + period; }

  /* ==================== 时间工具 ==================== */

  function toMinutes(text) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(text == null ? '' : text).trim());
    if (!m) return null;
    var h = Number(m[1]), mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  }

  function toHHMM(minutes) {
    minutes = Math.round(minutes);
    minutes = ((minutes % 1440) + 1440) % 1440;
    return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' +
           String(minutes % 60).padStart(2, '0');
  }

  function normalizeTime(value, fallback) {
    var m = toMinutes(value);
    return m === null ? fallback : toHHMM(m);
  }

  function clampInt(value, min, max, fallback) {
    if (value === '' || value === null || value === undefined) return fallback;
    var n = Math.round(Number(value));
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  /* ==================== 节次生成 ==================== */

  function buildPeriods(s) {
    var periodLen = Math.max(1, Math.round(Number(s.periodMinutes)) || 45);
    var brk = Math.max(0, Math.round(Number(s.breakMinutes)) || 0);

    var mStart = toMinutes(s.morningStart);
    var mEnd = toMinutes(s.morningEnd);
    var aStart = toMinutes(s.afternoonStart);
    var aEnd = toMinutes(s.afternoonEnd);

    if (mStart === null) mStart = 8 * 60;
    if (aStart === null) aStart = 14 * 60;
    if (aEnd === null) aEnd = 18 * 60;
    // 兼容旧数据：没有“上午结束”时，沿用“下午开始”作为上午边界
    if (mEnd === null) mEnd = aStart;

    if (aStart < mStart) aStart = mStart;
    if (mEnd <= mStart) mEnd = mStart + periodLen;
    if (aEnd <= aStart) aEnd = aStart + periodLen;

    // 上午不越过下午开始，避免时间重叠
    var amEnd = Math.min(mEnd, aStart);

    var list = [];
    var guard;

    // 上午
    var cur = mStart;
    guard = 0;
    while (cur + periodLen <= amEnd && guard++ < 60) {
      list.push({ start: toHHMM(cur), end: toHHMM(cur + periodLen), session: 'am' });
      cur += periodLen + brk;
    }
    if (list.length === 0) {
      list.push({ start: toHHMM(mStart), end: toHHMM(mStart + periodLen), session: 'am' });
    }

    // 下午
    cur = aStart;
    guard = 0;
    var pmCount = 0;
    while (cur + periodLen <= aEnd && guard++ < 60) {
      list.push({ start: toHHMM(cur), end: toHHMM(cur + periodLen), session: 'pm' });
      cur += periodLen + brk;
      pmCount++;
    }
    if (pmCount === 0) {
      list.push({ start: toHHMM(aStart), end: toHHMM(aStart + periodLen), session: 'pm' });
    }

    applyExtraBreaks(list, s.extraBreaks);

    return list;
  }

  /* 在第 N 节前插入额外休息（按上午/下午分别累计位移） */
  function applyExtraBreaks(list, extras) {
    if (!extras || typeof extras !== 'object') return;

    var shift = 0;
    for (var i = 0; i < list.length; i++) {
      if (i > 0 && list[i].session !== list[i - 1].session) shift = 0;
      var extra = clampInt(extras[i + 1], 0, 600, 0);
      shift += extra;
      if (!shift) continue;
      list[i].start = toHHMM(toMinutes(list[i].start) + shift);
      list[i].end = toHHMM(toMinutes(list[i].end) + shift);
    }
  }

  /* ==================== 颜色 ==================== */

  function colorFor(name) {
    if (!name) return '#8b95a1';
    if (state.colors[name]) return state.colors[name];
    var h = 0;
    for (var i = 0; i < name.length; i++) {
      h = (h * 31 + name.charCodeAt(i)) >>> 0;
    }
    return PALETTE[h % PALETTE.length];
  }

  /* ==================== 存储 ==================== */

  function saveLocal() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  function applyData(data) {
    if (!data || typeof data !== 'object') throw new Error('内容不是有效的对象');

    var s = (data.settings && typeof data.settings === 'object') ? data.settings : {};
    var extraBreaks = {};
    var rawExtras = (s.extraBreaks && typeof s.extraBreaks === 'object') ? s.extraBreaks : {};
    Object.keys(rawExtras).forEach(function (k) {
      var n = Math.round(Number(k));
      var v = clampInt(rawExtras[k], 1, 600, 0);
      if (n >= 2 && v > 0) extraBreaks[n] = v;
    });

    var afternoonStart = normalizeTime(s.afternoonStart, DEFAULT_SETTINGS.afternoonStart);

    var settings = {
      morningStart: normalizeTime(s.morningStart, DEFAULT_SETTINGS.morningStart),
      morningEnd: normalizeTime(s.morningEnd, afternoonStart),
      afternoonStart: afternoonStart,
      afternoonEnd: normalizeTime(s.afternoonEnd, DEFAULT_SETTINGS.afternoonEnd),
      periodMinutes: clampInt(s.periodMinutes, 1, 300, DEFAULT_SETTINGS.periodMinutes),
      breakMinutes: clampInt(s.breakMinutes, 0, 120, DEFAULT_SETTINGS.breakMinutes),
      extraBreaks: extraBreaks,
      hideEmptyPeriods: s.hideEmptyPeriods === undefined
        ? DEFAULT_SETTINGS.hideEmptyPeriods
        : Boolean(s.hideEmptyPeriods)
    };

    var days = (Array.isArray(data.days) && data.days.length)
      ? data.days.map(function (d) { return String(d); })
      : DEFAULT_DAYS.slice();

    var hiddenDays = [];
    if (Array.isArray(data.hiddenDays)) {
      data.hiddenDays.forEach(function (v) {
        var n = Math.round(Number(v));
        if (isFinite(n) && n >= 0 && n < days.length && hiddenDays.indexOf(n) < 0) {
          hiddenDays.push(n);
        }
      });
    }
    hiddenDays.sort(function (a, b) { return a - b; });
    if (hiddenDays.length >= days.length) hiddenDays = hiddenDays.slice(0, days.length - 1);

    var periods = buildPeriods(settings);

    var courses = {};
    var rawCourses = (data.courses && typeof data.courses === 'object') ? data.courses : {};
    Object.keys(rawCourses).forEach(function (k) {
      var m = /^(\d+)-(\d+)$/.exec(k);
      if (!m) return;
      var d = Number(m[1]), p = Number(m[2]);
      if (d >= days.length || p >= periods.length) return;
      var c = rawCourses[k];
      if (!c || typeof c !== 'object') return;
      var item = {
        name: String(c.name || '').trim(),
        teacher: String(c.teacher || '').trim(),
        room: String(c.room || '').trim(),
        note: String(c.note || '').trim()
      };
      if (!item.name && !item.teacher && !item.room && !item.note) return;
      if (!item.name) item.name = '未命名';
      courses[k] = item;
    });

    var colors = {};
    var rawColors = (data.colors && typeof data.colors === 'object') ? data.colors : {};
    Object.keys(rawColors).forEach(function (k) {
      var v = String(rawColors[k] || '').trim();
      if (/^#[0-9a-fA-F]{6}$/.test(v)) colors[k] = v;
    });

    state = {
      days: days,
      hiddenDays: hiddenDays,
      settings: settings,
      periods: periods,
      courses: courses,
      colors: colors
    };
    dragSource = null;
    editTarget = null;
  }

  function loadLocal() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      applyData(JSON.parse(raw));
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ==================== 日期显隐 ==================== */

  function isDayHidden(di) {
    return state.hiddenDays.indexOf(di) >= 0;
  }

  function visibleDayIndices() {
    var list = [];
    for (var i = 0; i < state.days.length; i++) {
      if (!isDayHidden(i)) list.push(i);
    }
    if (list.length === 0) list.push(0);
    return list;
  }

  function toggleDay(di) {
    var idx = state.hiddenDays.indexOf(di);
    if (idx >= 0) {
      state.hiddenDays.splice(idx, 1);
    } else {
      if (visibleDayIndices().length <= 1) return;
      state.hiddenDays.push(di);
      state.hiddenDays.sort(function (a, b) { return a - b; });
    }
    saveLocal();
    render();
  }

  function showAllDays() {
    state.hiddenDays = [];
    saveLocal();
    render();
  }

  function renderDayToggles() {
    var wrap = $('dayToggles');
    wrap.innerHTML = '';
    var visibleCount = visibleDayIndices().length;

    state.days.forEach(function (name, di) {
      var hidden = isDayHidden(di);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'day-toggle';
      btn.textContent = name;
      btn.setAttribute('aria-pressed', hidden ? 'false' : 'true');
      btn.title = hidden ? ('显示' + name) : ('隐藏' + name);
      btn.disabled = !hidden && visibleCount <= 1;
      btn.addEventListener('click', function () { toggleDay(di); });
      wrap.appendChild(btn);
    });
  }

  /* ==================== 渲染 ==================== */

  function isMobileView() {
    return window.innerWidth <= 640;
  }

  function periodHasCourse(pi, dayList) {
    for (var i = 0; i < dayList.length; i++) {
      if (state.courses[cellKey(dayList[i], pi)]) return true;
    }
    return false;
  }

  function render() {
    renderDayToggles();

    var table = $('timetable');
    var dayList = visibleDayIndices();
    var slotWidth = isMobileView() ? 104 : 124;
    var dayWidth = isMobileView() ? 124 : 150;

    table.innerHTML = '';
    table.classList.toggle('drag-on', dragEnabled);
    table.style.minWidth = (slotWidth + dayList.length * dayWidth) + 'px';

    // 列宽
    var colgroup = document.createElement('colgroup');
    var colSlot = document.createElement('col');
    colSlot.style.width = slotWidth + 'px';
    colgroup.appendChild(colSlot);
    dayList.forEach(function () {
      var col = document.createElement('col');
      col.style.width = dayWidth + 'px';
      colgroup.appendChild(col);
    });
    table.appendChild(colgroup);

    // 表头
    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');
    ['节次 / 时间'].concat(dayList.map(function (di) { return state.days[di]; }))
      .forEach(function (text, i) {
        var th = document.createElement('th');
        if (i === 0) th.className = 'slot-head';
        th.textContent = text;
        headRow.appendChild(th);
      });
    thead.appendChild(headRow);
    table.appendChild(thead);

    // 自动隐藏空行；整张表都没有课程时仍显示全部，方便添加
    var hideEmpty = state.settings.hideEmptyPeriods;
    if (hideEmpty) {
      var hasAny = false;
      for (var k = 0; k < state.periods.length; k++) {
        if (periodHasCourse(k, dayList)) { hasAny = true; break; }
      }
      if (!hasAny) hideEmpty = false;
    }

    // 表体
    var tbody = document.createElement('tbody');
    var pmStarted = false;
    state.periods.forEach(function (p, pi) {
      if (hideEmpty && !periodHasCourse(pi, dayList)) return;

      if (p.session === 'pm' && !pmStarted) {
        pmStarted = true;
        tbody.appendChild(buildNoonRow(dayList));
      }

      var tr = document.createElement('tr');

      var tdSlot = document.createElement('td');
      tdSlot.className = 'slot-col';

      var noEl = document.createElement('div');
      noEl.className = 'slot-no';
      noEl.textContent = '第' + (pi + 1) + '节';
      tdSlot.appendChild(noEl);

      var timeEl = document.createElement('div');
      timeEl.className = 'slot-time';
      timeEl.textContent = p.start + ' – ' + p.end;
      tdSlot.appendChild(timeEl);

      tr.appendChild(tdSlot);

      dayList.forEach(function (di) {
        tr.appendChild(buildCell(di, pi));
      });

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    updateCurrentClass();
    setupMarquees();
  }

  function currentCellInfo() {
    var now = new Date();
    var todayAliases = [
      ['周日', '周天', '星期日', '星期天'],
      ['周一', '星期一'],
      ['周二', '星期二'],
      ['周三', '星期三'],
      ['周四', '星期四'],
      ['周五', '星期五'],
      ['周六', '星期六']
    ];
    var today = todayAliases[now.getDay()];
    var di = -1;
    for (var d = 0; d < state.days.length; d++) {
      if (today.indexOf(state.days[d]) >= 0) { di = d; break; }
    }
    if (di < 0) return null;

    var mins = now.getHours() * 60 + now.getMinutes();
    for (var i = 0; i < state.periods.length; i++) {
      var p = state.periods[i];
      var start = toMinutes(p.start);
      var end = toMinutes(p.end);
      if (start === null || end === null) continue;
      if (mins >= start && mins < end) {
        return state.courses[cellKey(di, i)] ? { day: di, period: i } : null;
      }
    }
    return null;
  }

  function updateCurrentClass() {
    var old = document.querySelectorAll('#timetable td.cell.current');
    for (var i = 0; i < old.length; i++) old[i].classList.remove('current');

    var info = currentCellInfo();
    if (!info) return;

    var cell = document.querySelector(
      '#timetable td.cell[data-day="' + info.day + '"][data-period="' + info.period + '"]'
    );
    if (cell) cell.classList.add('current');
  }

  function setupMarquees() {
    var names = document.querySelectorAll('#timetable .c-name');
    for (var i = 0; i < names.length; i++) {
      var el = names[i];
      var inner = el.firstElementChild;
      el.classList.remove('marquee');
      el.style.removeProperty('--marquee-distance');
      el.style.removeProperty('--marquee-duration');
      if (!inner) continue;

      var overflow = inner.scrollWidth - el.clientWidth;
      if (overflow <= 2) continue;

      el.classList.add('marquee');
      el.style.setProperty('--marquee-distance', (-overflow) + 'px');
      el.style.setProperty('--marquee-duration', Math.max(4, Math.round(overflow / 30)) + 's');
    }
  }

  function buildNoonRow(dayList) {
    var tr = document.createElement('tr');
    tr.className = 'noon-row';

    var tdSlot = document.createElement('td');
    tdSlot.className = 'noon-cell noon-slot';
    var slotLine = document.createElement('div');
    slotLine.className = 'noon-line';
    var label = document.createElement('span');
    label.textContent = '中午';
    slotLine.appendChild(label);
    tdSlot.appendChild(slotLine);
    tr.appendChild(tdSlot);

    dayList.forEach(function () {
      var td = document.createElement('td');
      td.className = 'noon-cell';
      var line = document.createElement('div');
      line.className = 'noon-line';
      td.appendChild(line);
      tr.appendChild(td);
    });

    return tr;
  }

  function buildCell(di, pi) {
    var key = cellKey(di, pi);
    var course = state.courses[key];
    var td = document.createElement('td');

    td.className = 'cell';
    td.dataset.day = String(di);
    td.dataset.period = String(pi);

    if (course) {
      td.style.background = colorFor(course.name);
      td.style.color = '#ffffff';

      var nameEl = document.createElement('div');
      nameEl.className = 'c-name';
      var nameText = document.createElement('span');
      nameText.className = 'c-name-text';
      nameText.textContent = course.name;
      nameEl.appendChild(nameText);
      td.appendChild(nameEl);

      var metaParts = [];
      if (course.teacher) metaParts.push(course.teacher);
      if (course.room) metaParts.push(course.room);
      if (metaParts.length) {
        var metaEl = document.createElement('div');
        metaEl.className = 'c-meta';
        metaEl.textContent = metaParts.join(' · ');
        td.appendChild(metaEl);
      }

      if (course.note) {
        var noteEl = document.createElement('div');
        noteEl.className = 'c-note';
        noteEl.textContent = course.note;
        td.appendChild(noteEl);
      }

      if (dragEnabled) td.draggable = true;
    } else {
      td.classList.add('empty');
    }

    td.addEventListener('click', function () { openCourseModal(di, pi); });

    td.addEventListener('dragstart', function (e) {
      if (!dragEnabled || !state.courses[key]) { e.preventDefault(); return; }
      dragSource = key;
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', key); } catch (err) {}
      td.classList.add('dragging');
    });

    td.addEventListener('dragend', function () {
      td.classList.remove('dragging');
      dragSource = null;
      clearDropTargets();
    });

    td.addEventListener('dragover', function (e) {
      if (!dragEnabled || !dragSource) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      td.classList.add('drop-target');
    });

    td.addEventListener('dragleave', function () {
      td.classList.remove('drop-target');
    });

    td.addEventListener('drop', function (e) {
      e.preventDefault();
      td.classList.remove('drop-target');
      var src = dragSource;
      dragSource = null;
      if (!src || src === key) return;
      moveOrSwap(src, key);
    });

    return td;
  }

  function clearDropTargets() {
    var list = document.querySelectorAll('.drop-target');
    for (var i = 0; i < list.length; i++) list[i].classList.remove('drop-target');
  }

  function moveOrSwap(srcKey, dstKey) {
    var moving = state.courses[srcKey];
    if (!moving) return;

    var target = state.courses[dstKey];

    if (target) {
      state.courses[srcKey] = target;
    } else {
      delete state.courses[srcKey];
    }
    state.courses[dstKey] = moving;

    saveLocal();
    render();
  }

  /* ==================== 课程编辑弹窗 ==================== */

  function openCourseModal(di, pi) {
    editTarget = { day: di, period: pi };

    var course = state.courses[cellKey(di, pi)];
    var period = state.periods[pi];

    $('courseModalTitle').textContent =
      state.days[di] + ' 第' + (pi + 1) + '节 · ' +
      (period.session === 'am' ? '上午' : '下午') + ' ' +
      period.start + '–' + period.end;

    $('cName').value = course ? (course.name || '') : '';
    $('cTeacher').value = course ? (course.teacher || '') : '';
    $('cRoom').value = course ? (course.room || '') : '';
    $('cNote').value = course ? (course.note || '') : '';

    editColorPicked = (course && state.colors[course.name]) ? state.colors[course.name] : null;

    $('btnDeleteCourse').style.display = course ? '' : 'none';

    renderSwatches();
    openModal('modalCourse');

    setTimeout(function () { $('cName').focus(); }, 0);
  }

  function renderSwatches() {
    var wrap = $('colorSwatches');
    wrap.innerHTML = '';

    var name = $('cName').value.trim();
    var currentColor = colorFor(name);

    // 自动配色
    var autoBtn = document.createElement('button');
    autoBtn.type = 'button';
    autoBtn.className = 'swatch auto' + (editColorPicked ? '' : ' active');
    autoBtn.textContent = '自动';
    autoBtn.title = '按课程名自动配色';
    autoBtn.addEventListener('click', function () {
      editColorPicked = null;
      renderSwatches();
    });
    wrap.appendChild(autoBtn);

    // 色板
    PALETTE.forEach(function (color) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'swatch' +
        ((editColorPicked ? editColorPicked === color : currentColor === color) ? ' active' : '');
      btn.style.background = color;
      btn.title = color;
      btn.addEventListener('click', function () {
        editColorPicked = color;
        renderSwatches();
      });
      wrap.appendChild(btn);
    });
  }

  function saveCourseEdit() {
    if (!editTarget) return;

    var name = $('cName').value.trim();
    var teacher = $('cTeacher').value.trim();
    var room = $('cRoom').value.trim();
    var note = $('cNote').value.trim();
    var key = cellKey(editTarget.day, editTarget.period);

    if (!name && !teacher && !room && !note) {
      delete state.courses[key];
    } else {
      if (!name) name = '未命名';
      state.courses[key] = { name: name, teacher: teacher, room: room, note: note };

      if (editColorPicked) {
        state.colors[name] = editColorPicked;
      } else {
        delete state.colors[name];
      }
    }

    saveLocal();
    render();
    closeModal('modalCourse');
  }

  function deleteCourseEdit() {
    if (!editTarget) return;
    delete state.courses[cellKey(editTarget.day, editTarget.period)];
    saveLocal();
    render();
    closeModal('modalCourse');
  }

  /* ==================== 时间设置弹窗 ==================== */

  function openSettings() {
    var s = state.settings;
    $('setMorningStart').value = s.morningStart;
    $('setMorningEnd').value = s.morningEnd;
    $('setAfternoonStart').value = s.afternoonStart;
    $('setAfternoonEnd').value = s.afternoonEnd;
    $('setPeriodLen').value = s.periodMinutes;
    $('setBreak').value = s.breakMinutes;
    $('hideEmptySwitch').checked = !!s.hideEmptyPeriods;

    draftExtras = {};
    Object.keys(s.extraBreaks || {}).forEach(function (k) {
      draftExtras[k] = s.extraBreaks[k];
    });
    $('extraMinutes').value = '';
    $('extraMsg').textContent = '';

    renderExtraEditor();
    openModal('modalSettings');
  }

  function renderExtraEditor() {
    var list = $('extraList');
    list.innerHTML = '';

    var keys = Object.keys(draftExtras)
      .map(Number)
      .filter(function (n) { return n >= 2 && n <= state.periods.length; })
      .sort(function (a, b) { return a - b; });

    if (!keys.length) {
      var empty = document.createElement('p');
      empty.className = 'extra-empty';
      empty.textContent = '暂无额外休息。';
      list.appendChild(empty);
    }

    keys.forEach(function (n) {
      var row = document.createElement('div');
      row.className = 'extra-row';

      var label = document.createElement('span');
      label.className = 'extra-label';
      label.textContent = '第' + n + '节前';
      row.appendChild(label);

      var input = document.createElement('input');
      input.type = 'number';
      input.min = '1';
      input.max = '600';
      input.step = '5';
      input.value = draftExtras[n];
      input.addEventListener('change', function () {
        var v = clampInt(input.value, 1, 600, 0);
        if (!v) {
          delete draftExtras[n];
        } else {
          draftExtras[n] = v;
        }
        renderExtraEditor();
      });
      row.appendChild(input);

      var unit = document.createElement('span');
      unit.className = 'extra-unit';
      unit.textContent = '分钟';
      row.appendChild(unit);

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'extra-del danger';
      del.textContent = '删除';
      del.addEventListener('click', function () {
        delete draftExtras[n];
        renderExtraEditor();
      });
      row.appendChild(del);

      list.appendChild(row);
    });

    var sel = $('extraPeriod');
    var prev = sel.value;
    sel.innerHTML = '';
    for (var i = 2; i <= state.periods.length; i++) {
      var opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = '第' + i + '节前';
      sel.appendChild(opt);
    }
    if (prev) {
      var matched = false;
      for (var j = 0; j < sel.options.length; j++) {
        if (sel.options[j].value === prev) { matched = true; break; }
      }
      if (matched) sel.value = prev;
    }
  }

  function addExtraBreak() {
    var n = Number($('extraPeriod').value);
    var v = clampInt($('extraMinutes').value, 1, 600, 0);
    var msg = $('extraMsg');

    if (!(n >= 2 && n <= state.periods.length)) {
      msg.textContent = '请选择要调整的节次。';
      return;
    }
    if (!v) {
      msg.textContent = '请输入 1–600 之间的分钟数。';
      return;
    }

    draftExtras[n] = v;
    $('extraMinutes').value = '';
    msg.textContent = '已添加：第' + n + '节前休息 ' + v + ' 分钟。';
    renderExtraEditor();
  }

  function applySettings() {
    var s = state.settings;

    var m = toMinutes($('setMorningStart').value);
    if (m !== null) s.morningStart = toHHMM(m);

    var me = toMinutes($('setMorningEnd').value);
    if (me !== null) s.morningEnd = toHHMM(me);

    var a = toMinutes($('setAfternoonStart').value);
    if (a !== null) s.afternoonStart = toHHMM(a);

    var e = toMinutes($('setAfternoonEnd').value);
    if (e !== null) s.afternoonEnd = toHHMM(e);

    s.periodMinutes = clampInt($('setPeriodLen').value, 1, 300, s.periodMinutes);
    s.breakMinutes = clampInt($('setBreak').value, 0, 120, s.breakMinutes);

    var extras = {};
    Object.keys(draftExtras).forEach(function (k) {
      var n = Math.round(Number(k));
      var v = clampInt(draftExtras[k], 1, 600, 0);
      if (n >= 2 && v > 0) extras[n] = v;
    });
    s.extraBreaks = extras;

    state.periods = buildPeriods(s);

    // 清理超出节次范围的额外休息
    Object.keys(s.extraBreaks).forEach(function (k) {
      if (Number(k) > state.periods.length) delete s.extraBreaks[k];
    });

    // 清理超出节次范围的课程
    var count = state.periods.length;
    Object.keys(state.courses).forEach(function (k) {
      var p = Number(k.split('-')[1]);
      if (!(p >= 0 && p < count)) delete state.courses[k];
    });

    saveLocal();
    render();
    closeModal('modalSettings');
  }

  /* ==================== 导入 / 导出 ==================== */

  function openIO() {
    $('ioMsg').textContent = '';
    openModal('modalIO');
  }

  function exportToArea() {
    var text = JSON.stringify(state, null, 2);
    $('ioArea').value = text;
    copyText(text, function (ok) {
      $('ioMsg').textContent = ok
        ? '已导出到下方文本框，并复制到剪贴板。'
        : '已导出到下方文本框（自动复制失败，请手动选择复制）。';
    });
  }

  function copyAreaText() {
    var text = $('ioArea').value;
    if (!text) { $('ioMsg').textContent = '文本框是空的。'; return; }
    copyText(text, function (ok) {
      $('ioMsg').textContent = ok ? '已复制到剪贴板。' : '复制失败，请手动选择后按 Ctrl+C。';
    });
  }

  function importFromArea() {
    var text = $('ioArea').value.trim();
    if (!text) { $('ioMsg').textContent = '文本框是空的，无法导入。'; return; }
    try {
      applyData(JSON.parse(text));
      saveLocal();
      render();
      $('ioMsg').textContent = '导入成功，新数据已应用。';
    } catch (err) {
      $('ioMsg').textContent = '导入失败：' + err.message;
    }
  }

  /* ==================== 剪贴板 ==================== */

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function copyText(text, callback) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(
        function () { callback(true); },
        function () { callback(legacyCopy(text)); }
      );
    } else {
      callback(legacyCopy(text));
    }
  }

  /* ==================== 弹窗控制 ==================== */

  function openModal(id) { $(id).hidden = false; }
  function closeModal(id) { $(id).hidden = true; }

  function closeAllModals() {
    var masks = document.querySelectorAll('.mask');
    for (var i = 0; i < masks.length; i++) masks[i].hidden = true;
  }

  /* ==================== 事件绑定 ==================== */

  function bindEvents() {
    // 拖动开关
    $('dragSwitch').addEventListener('change', function () {
      dragEnabled = this.checked;
      render();
    });

    // 顶栏按钮
    $('btnOpenSettings').addEventListener('click', openSettings);
    $('btnOpenIO').addEventListener('click', function () {
      closeModal('modalSettings');
      openIO();
    });

    // 日期显隐 / 空行
    $('btnShowAllDays').addEventListener('click', showAllDays);
    $('hideEmptySwitch').addEventListener('change', function () {
      state.settings.hideEmptyPeriods = this.checked;
      saveLocal();
      render();
    });

    // 时间设置
    $('btnApplySettings').addEventListener('click', applySettings);
    $('btnAddExtra').addEventListener('click', addExtraBreak);
    $('extraMinutes').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addExtraBreak(); }
    });

    // 课程编辑
    $('btnSaveCourse').addEventListener('click', saveCourseEdit);
    $('btnDeleteCourse').addEventListener('click', deleteCourseEdit);

    ['cName', 'cTeacher', 'cRoom', 'cNote'].forEach(function (id) {
      $(id).addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); saveCourseEdit(); }
      });
    });

    // 课程名变化时刷新色板预览
    $('cName').addEventListener('input', renderSwatches);

    // 导入导出
    $('btnExport').addEventListener('click', exportToArea);
    $('btnCopyArea').addEventListener('click', copyAreaText);
    $('btnImport').addEventListener('click', importFromArea);

    // 关闭按钮
    var closers = document.querySelectorAll('[data-close]');
    for (var i = 0; i < closers.length; i++) {
      closers[i].addEventListener('click', function () {
        var mask = this.closest('.mask');
        if (mask) mask.hidden = true;
      });
    }

    // 点击遮罩关闭（导入 / 导出只能由 × 关闭）
    var masks = document.querySelectorAll('.mask');
    for (var j = 0; j < masks.length; j++) {
      masks[j].addEventListener('mousedown', function (e) {
        if (e.target !== this) return;
        if (this.id === 'modalIO') return;
        this.hidden = true;
      });
    }

    // Esc 关闭（导入 / 导出弹窗除外）
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!$('modalIO').hidden) return;
      closeAllModals();
    });
  }

  /* ==================== 启动 ==================== */

  function bindViewport() {
    var resizeTimer = null;
    window.addEventListener('resize', function () {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        updateCurrentClass();
        setupMarquees();
      }, 150);
    });

    if (!window.matchMedia) return;
    var mq = window.matchMedia('(max-width: 640px)');
    var onChange = function () { render(); };
    if (mq.addEventListener) {
      mq.addEventListener('change', onChange);
    } else if (mq.addListener) {
      mq.addListener(onChange);
    }
  }

  function init() {
    if (!loadLocal()) {
      state.settings = Object.assign({}, DEFAULT_SETTINGS, { extraBreaks: {} });
      state.periods = buildPeriods(state.settings);
      state.courses = {};
      state.colors = {};
      state.hiddenDays = [];
    }
    bindEvents();
    bindViewport();
    render();

    setInterval(updateCurrentClass, 30000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) updateCurrentClass();
    });
  }

  init();
})();
