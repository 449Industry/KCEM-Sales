(() => {
  const cfg = window.KCEM_CONFIG || {};
  const STORAGE = {
    token: "kcem_public_access_token",
    expires: "kcem_public_access_expires",
    device: "kcem_public_device_id"
  };

  const $ = id => document.getElementById(id);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const won = v => `${Number(v || 0).toLocaleString("ko-KR")}원`;
  const pad = n => String(n).padStart(2, "0");

  function kstParts() {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(new Date());
    const obj = {};
    for (const p of parts) if (p.type !== "literal") obj[p.type] = p.value;
    return { year: Number(obj.year), month: Number(obj.month), day: Number(obj.day) };
  }

  const now = kstParts();
  const state = {
    view: "detail",
    year: now.year,
    month: now.month,
    detailDayFilter: null,
    rows: [],
    loading: false,
    pollTimer: null
  };

  let client = null;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, ch => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    }[ch]));
  }

  function getDeviceId() {
    let id = localStorage.getItem(STORAGE.device);
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(STORAGE.device, id);
    }
    return id;
  }

  function getToken() {
    const token = localStorage.getItem(STORAGE.token);
    const expires = localStorage.getItem(STORAGE.expires);
    if (!token || !expires) return null;
    if (new Date(expires).getTime() <= Date.now()) {
      clearAccess();
      return null;
    }
    return token;
  }

  function saveAccess(token, expires) {
    localStorage.setItem(STORAGE.token, token);
    localStorage.setItem(STORAGE.expires, expires);
  }

  function clearAccess() {
    localStorage.removeItem(STORAGE.token);
    localStorage.removeItem(STORAGE.expires);
  }

  function showPin(message = "") {
    $("pinMessage").textContent = message;
    $("pinInput").value = "";
    $("pinOverlay").classList.remove("hidden");
    $("logoutBtn").classList.add("hidden");
    $("statusBadge").textContent = "PIN 입력 필요";
    setTimeout(() => $("pinInput").focus(), 50);
  }

  function hidePin() {
    $("pinOverlay").classList.add("hidden");
    $("logoutBtn").classList.remove("hidden");
  }

  function cleanError(error) {
    const raw = [error?.message, error?.details, error?.hint, error?.code].filter(Boolean).join(" / ");
    const message = raw || String(error || "오류가 발생했습니다.");
    if (message.includes("PGRST202") || message.includes("Could not find the function")) {
      return "Supabase에서 KCEM 조회 함수를 찾지 못했습니다.";
    }
    if (message.includes("조회 인증이 만료")) return "조회 인증이 만료되었습니다. PIN을 다시 입력하세요.";
    if (message.includes("조회 PIN이 아직 설정")) return "Supabase에 조회 PIN이 아직 설정되지 않았습니다.";
    if (message.includes("PIN이 올바르지")) return "PIN이 올바르지 않습니다.";
    return message;
  }

  function initClient() {
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY) throw new Error("config.js의 Supabase 연결값이 없습니다.");
    client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
  }

  function initYearOptions() {
    const select = $("yearInput");
    select.innerHTML = "";
    const first = Math.min(Number(cfg.FIRST_YEAR || 2026), now.year);
    const last = now.year + 5;
    for (let y = last; y >= first; y--) {
      const op = document.createElement("option");
      op.value = String(y);
      op.textContent = `${y}년`;
      select.appendChild(op);
    }
    select.value = String(state.year);
    $("monthInput").value = String(state.month);
  }

  async function login(pin) {
    $("pinSubmit").disabled = true;
    $("pinSubmit").textContent = "확인 중…";
    $("pinMessage").textContent = "";
    try {
      const { data, error } = await client.rpc("kcem_public_login", {
        p_pin: pin,
        p_device_id: getDeviceId()
      });
      if (error) throw error;
      const session = Array.isArray(data) ? data[0] : data;
      if (!session?.access_token || !session?.expires_at) throw new Error("조회 토큰을 받지 못했습니다.");
      saveAccess(session.access_token, session.expires_at);
      hidePin();
      await loadYear(true);
      startPolling();
    } catch (err) {
      console.error("KCEM PIN login error:", err);
      showPin(cleanError(err));
    } finally {
      $("pinSubmit").disabled = false;
      $("pinSubmit").textContent = "확인";
    }
  }

  async function logout() {
    const token = getToken();
    try {
      if (token) await client.rpc("kcem_public_logout", { p_token: token });
    } catch (_) {}
    clearAccess();
    stopPolling();
    state.rows = [];
    render();
    showPin("이 기기의 조회 인증을 해제했습니다.");
  }

  async function loadYear(force = false) {
    const token = getToken();
    if (!token) { showPin(); return; }
    if (state.loading && !force) return;
    state.loading = true;
    $("statusBadge").textContent = "갱신 중";
    try {
      const { data, error } = await client.rpc("kcem_public_sales", {
        p_token: token,
        p_year: state.year
      });
      if (error) throw error;
      state.rows = Array.isArray(data) ? data : [];
      $("statusBadge").textContent = "연결됨";
      hidePin();
      render();
    } catch (err) {
      const msg = cleanError(err);
      if (msg.includes("인증") || msg.includes("PIN")) {
        clearAccess(); stopPolling(); showPin(msg);
      } else {
        $("statusBadge").textContent = "조회 오류";
        console.error(err);
      }
    } finally {
      state.loading = false;
    }
  }

  function startPolling() {
    stopPolling();
    const interval = Math.max(3000, Number(cfg.POLL_INTERVAL_MS || 5000));
    state.pollTimer = setInterval(() => { if (!document.hidden) loadYear(); }, interval);
  }

  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  function monthRows(month = state.month) {
    return state.rows.filter(r => Number(String(r.sale_date).slice(5, 7)) === Number(month));
  }

  function summarize(rows) {
    const s = { cashOnly: 0, account: 0, siru: 0, card: 0, cashGroup: 0, total: 0 };
    for (const row of rows) {
      const amount = Number(row.amount || 0);
      if (row.payment_method === "현금") s.cashOnly += amount;
      else if (row.payment_method === "계좌") s.account += amount;
      else if (row.payment_method === "시루") s.siru += amount;
      else if (row.payment_method === "카드") s.card += amount;
      s.total += amount;
    }
    s.cashGroup = s.cashOnly + s.account + s.siru;
    return s;
  }

  function setDetailSummary(rows) {
    const s = summarize(rows);
    $("sumCashOnly").textContent = won(s.cashOnly);
    $("sumAccount").textContent = won(s.account);
    $("sumSiru").textContent = won(s.siru);
    $("sumCardDetail").textContent = won(s.card);
    $("sumTotalDetail").textContent = won(s.total);
  }

  function setCalendarSummary(rows) {
    const s = summarize(rows);
    $("sumCashGroup").textContent = won(s.cashGroup);
    $("sumCardGroup").textContent = won(s.card);
    $("sumTotalGroup").textContent = won(s.total);
  }

  function renderDetail() {
    let rows = monthRows();
    if (state.detailDayFilter) rows = rows.filter(r => r.sale_date === state.detailDayFilter);
    rows = [...rows].sort((a, b) => {
      const byDate = String(b.sale_date).localeCompare(String(a.sale_date));
      return byDate || String(b.sale_time || "").localeCompare(String(a.sale_time || ""));
    });

    if (state.detailDayFilter) {
      $("detailTitle").textContent = `${state.detailDayFilter} 건별 매출내역`;
      $("detailSub").textContent = "선택한 날짜의 판매 건만 표시합니다.";
      $("clearDayFilter").classList.remove("hidden");
    } else {
      $("detailTitle").textContent = `${state.year}년 ${state.month}월 건별 매출내역`;
      $("detailSub").textContent = "판매가 발생한 건만 날짜·시간순으로 표시합니다.";
      $("clearDayFilter").classList.add("hidden");
    }

    $("detailCount").textContent = `${rows.length}건`;
    $("detailRows").innerHTML = rows.map(row => `
      <tr>
        <td><strong>${escapeHtml(row.sale_date)}</strong></td>
        <td>${escapeHtml(String(row.sale_time || "").slice(0, 5) || "-")}</td>
        <td class="item">${escapeHtml(row.item_name || "-")}</td>
        <td><span class="payment ${row.payment_method === "시루" ? "siru" : ""}">${escapeHtml(row.payment_method)}</span></td>
        <td class="right"><strong>${won(row.amount)}</strong></td>
        <td class="center">${Number(row.quantity || 1)}</td>
        <td class="memo">${escapeHtml(row.comment || "")}</td>
      </tr>
    `).join("");
    $("detailEmpty").classList.toggle("hidden", rows.length !== 0);
    setDetailSummary(rows);
  }

  function renderMonthCalendar() {
    const rows = monthRows();
    $("monthTitle").textContent = `${state.year}년 ${state.month}월 매출`;
    setCalendarSummary(rows);

    const grouped = new Map();
    for (const row of rows) {
      if (!grouped.has(row.sale_date)) grouped.set(row.sale_date, []);
      grouped.get(row.sale_date).push(row);
    }

    const firstDay = new Date(Date.UTC(state.year, state.month - 1, 1)).getUTCDay();
    const days = new Date(Date.UTC(state.year, state.month, 0)).getUTCDate();
    const cells = [];
    for (let i = 0; i < firstDay; i++) cells.push('<div class="calendar-cell empty-cell"></div>');

    for (let day = 1; day <= days; day++) {
      const date = `${state.year}-${pad(state.month)}-${pad(day)}`;
      const dayRows = grouped.get(date) || [];
      const s = summarize(dayRows);
      const weekday = (firstDay + day - 1) % 7;
      const weekendClass = weekday === 0 ? "sun" : (weekday === 6 ? "sat" : "");
      const salesClass = dayRows.length ? "has-sales" : "";
      cells.push(`
        <div class="calendar-cell ${weekendClass} ${salesClass}" data-date="${date}">
          <div class="calendar-day">${day}</div>
          ${dayRows.length ? `
            <div class="calendar-total">${won(s.total)}</div>
            <div class="calendar-lines">
              <div class="calendar-line"><span>현금</span><strong>${won(s.cashGroup)}</strong></div>
              <div class="calendar-line"><span>카드</span><strong>${won(s.card)}</strong></div>
            </div>
          ` : '<div class="calendar-none">-</div>'}
        </div>
      `);
    }

    const used = firstDay + days;
    const trailing = (7 - (used % 7)) % 7;
    for (let i = 0; i < trailing; i++) cells.push('<div class="calendar-cell empty-cell"></div>');
    $("monthCalendar").innerHTML = cells.join("");

    $$(".calendar-cell.has-sales").forEach(cell => {
      cell.addEventListener("click", () => {
        state.detailDayFilter = cell.dataset.date;
        state.view = "detail";
        render();
      });
    });
  }

  function renderYearCalendar() {
    $("yearTitle").textContent = `${state.year}년 연매출`;
    setCalendarSummary(state.rows);
    const cards = [];
    for (let m = 1; m <= 12; m++) {
      const rows = monthRows(m);
      const s = summarize(rows);
      cards.push(`
        <article class="month-card ${rows.length ? "" : "no-sales"}" data-month="${m}">
          <div class="month-card-head"><strong>${m}월</strong></div>
          <div class="month-card-total">${won(s.total)}</div>
          <div class="month-card-lines">
            <div class="month-card-line"><span>현금</span><strong>${won(s.cashGroup)}</strong></div>
            <div class="month-card-line"><span>카드</span><strong>${won(s.card)}</strong></div>
          </div>
        </article>
      `);
    }
    $("yearCalendar").innerHTML = cards.join("");
    $$(".month-card").forEach(card => {
      card.addEventListener("click", () => {
        state.month = Number(card.dataset.month);
        state.detailDayFilter = null;
        state.view = "month";
        render();
      });
    });
  }

  function render() {
    $("detailPanel").classList.toggle("hidden", state.view !== "detail");
    $("monthPanel").classList.toggle("hidden", state.view !== "month");
    $("yearPanel").classList.toggle("hidden", state.view !== "year");
    $("detailSummary").classList.toggle("hidden", state.view !== "detail");
    $("calendarSummary").classList.toggle("hidden", state.view === "detail");
    $("monthBox").classList.toggle("hidden", state.view === "year");

    for (const button of $$(".tab")) {
      button.classList.toggle("active", button.dataset.view === state.view);
    }
    $("yearInput").value = String(state.year);
    $("monthInput").value = String(state.month);

    if (state.view === "detail") renderDetail();
    else if (state.view === "month") renderMonthCalendar();
    else renderYearCalendar();

    $("lastUpdated").textContent = `마지막 갱신: ${new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    }).format(new Date())}`;
  }

  async function setYear(year) {
    state.year = Number(year);
    state.detailDayFilter = null;
    await loadYear(true);
  }

  function stepPeriod(delta) {
    if (state.view === "year") {
      state.year += delta;
      state.detailDayFilter = null;
      loadYear(true);
      return;
    }
    let m = state.month + delta;
    let y = state.year;
    if (m < 1) { m = 12; y--; }
    if (m > 12) { m = 1; y++; }
    state.month = m;
    state.detailDayFilter = null;
    if (y !== state.year) {
      state.year = y;
      loadYear(true);
    } else render();
  }

  function bindEvents() {
    for (const button of $$(".tab")) {
      button.addEventListener("click", () => {
        state.view = button.dataset.view;
        if (state.view !== "detail") state.detailDayFilter = null;
        render();
      });
    }

    $("pinForm").addEventListener("submit", e => {
      e.preventDefault();
      const pin = $("pinInput").value.trim();
      if (pin.length < 6) { $("pinMessage").textContent = "PIN을 입력하세요."; return; }
      login(pin);
    });

    $("logoutBtn").addEventListener("click", logout);
    $("yearInput").addEventListener("change", e => setYear(e.target.value));
    $("monthInput").addEventListener("change", e => {
      state.month = Number(e.target.value);
      state.detailDayFilter = null;
      render();
    });
    $("prevBtn").addEventListener("click", () => stepPeriod(-1));
    $("nextBtn").addEventListener("click", () => stepPeriod(1));
    $("clearDayFilter").addEventListener("click", () => {
      state.detailDayFilter = null;
      render();
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && getToken()) loadYear();
    });
  }

  async function start() {
    try {
      initClient();
      initYearOptions();
      bindEvents();
      render();
      if (!getToken()) { showPin(); return; }
      hidePin();
      await loadYear(true);
      startPolling();
    } catch (err) {
      showPin(cleanError(err));
    }
  }

  start();
})();
