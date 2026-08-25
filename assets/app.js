(() => {
  const cfg = window.KCEM_CONFIG || {};

  const STORAGE = {
    token: "kcem_public_access_token",
    expires: "kcem_public_access_expires",
    device: "kcem_public_device_id"
  };

  const $ = id => document.getElementById(id);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  const won = value =>
    `${Number(value || 0).toLocaleString("ko-KR")}원`;

  const num = value =>
    Number(value || 0).toLocaleString("ko-KR");

  const pad = n => String(n).padStart(2, "0");

  function kstParts() {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date());

    const obj = {};
    for (const part of parts) {
      if (part.type !== "literal") obj[part.type] = part.value;
    }

    return {
      year: Number(obj.year),
      month: Number(obj.month),
      day: Number(obj.day),
      ymd: `${obj.year}-${obj.month}-${obj.day}`
    };
  }

  const now = kstParts();

  const state = {
    view: "detail",
    year: now.year,
    month: now.month,
    selectedDay: null,
    rows: [],
    loading: false,
    pollTimer: null
  };

  let client = null;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, ch => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[ch]));
  }

  function getDeviceId() {
    let id = localStorage.getItem(STORAGE.device);

    if (!id) {
      id = crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

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
    const raw = [
      error?.message,
      error?.details,
      error?.hint,
      error?.code
    ].filter(Boolean).join(" / ");

    const message = raw || String(error || "오류가 발생했습니다.");

    if (
      message.includes("PGRST202") ||
      message.includes("Could not find the function")
    ) {
      return "Supabase에서 KCEM 조회 함수를 찾지 못했습니다.";
    }

    if (message.includes("조회 인증이 만료")) {
      return "조회 인증이 만료되었습니다. PIN을 다시 입력하세요.";
    }

    if (message.includes("조회 PIN이 아직 설정")) {
      return "Supabase에 조회 PIN이 아직 설정되지 않았습니다.";
    }

    if (message.includes("PIN이 올바르지")) {
      return "PIN이 올바르지 않습니다.";
    }

    return message;
  }

  function initClient() {
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY) {
      throw new Error("config.js의 Supabase 연결값이 없습니다.");
    }

    client = window.supabase.createClient(
      cfg.SUPABASE_URL,
      cfg.SUPABASE_PUBLISHABLE_KEY,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false
        }
      }
    );
  }

  async function login(pin) {
    $("pinSubmit").disabled = true;
    $("pinSubmit").textContent = "확인 중…";
    $("pinMessage").textContent = "";

    try {
      const { data, error } = await client.rpc(
        "kcem_public_login",
        {
          p_pin: pin,
          p_device_id: getDeviceId()
        }
      );

      if (error) throw error;

      const session = Array.isArray(data) ? data[0] : data;

      if (!session?.access_token || !session?.expires_at) {
        throw new Error("조회 토큰을 받지 못했습니다.");
      }

      saveAccess(session.access_token, session.expires_at);
      hidePin();
      await loadYear(true);
      startPolling();
    } catch (error) {
      console.error("KCEM PIN login error:", error);
      showPin(cleanError(error));
    } finally {
      $("pinSubmit").disabled = false;
      $("pinSubmit").textContent = "확인";
    }
  }

  async function logout() {
    const token = getToken();

    try {
      if (token) {
        await client.rpc("kcem_public_logout", {
          p_token: token
        });
      }
    } catch (_) {}

    clearAccess();
    stopPolling();
    state.rows = [];
    state.selectedDay = null;
    render();
    showPin("이 기기의 조회 인증을 해제했습니다.");
  }

  async function loadYear(force = false) {
    const token = getToken();

    if (!token) {
      showPin();
      return;
    }

    if (state.loading && !force) return;

    state.loading = true;
    $("statusBadge").textContent = "갱신 중";

    try {
      const { data, error } = await client.rpc(
        "kcem_public_sales",
        {
          p_token: token,
          p_year: state.year
        }
      );

      if (error) throw error;

      state.rows = Array.isArray(data) ? data : [];
      ensureSelectedDay();

      $("statusBadge").textContent = "연결됨";
      hidePin();
      render();
    } catch (error) {
      const msg = cleanError(error);

      if (msg.includes("인증") || msg.includes("PIN")) {
        clearAccess();
        stopPolling();
        showPin(msg);
      } else {
        $("statusBadge").textContent = "조회 오류";
        console.error(error);
      }
    } finally {
      state.loading = false;
    }
  }

  function startPolling() {
    stopPolling();

    const interval = Math.max(
      3000,
      Number(cfg.POLL_INTERVAL_MS || 5000)
    );

    state.pollTimer = setInterval(() => {
      if (!document.hidden) loadYear();
    }, interval);
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function monthRows(month = state.month) {
    return state.rows.filter(row =>
      Number(String(row.sale_date).slice(5, 7)) === Number(month)
    );
  }

  function summarize(rows) {
    const summary = {
      cashOnly: 0,
      account: 0,
      siru: 0,
      card: 0,
      cashGroup: 0,
      total: 0
    };

    for (const row of rows) {
      const amount = Number(row.amount || 0);

      if (row.payment_method === "현금") {
        summary.cashOnly += amount;
      } else if (row.payment_method === "계좌") {
        summary.account += amount;
      } else if (row.payment_method === "시루") {
        summary.siru += amount;
      } else if (row.payment_method === "카드") {
        summary.card += amount;
      }

      summary.total += amount;
    }

    summary.cashGroup =
      summary.cashOnly +
      summary.account +
      summary.siru;

    return summary;
  }

  function aggregateItems(rows) {
    const map = new Map();

    for (const row of rows) {
      const itemName = String(row.item_name || "미지정 품목").trim() || "미지정 품목";
      const key = itemName;
      const qty = Math.max(1, Number(row.quantity || 1));
      const amount = Number(row.amount || 0);

      if (!map.has(key)) {
        map.set(key, {
          itemName,
          quantity: 0,
          cashGroup: 0,
          card: 0,
          total: 0,
          transactions: 0
        });
      }

      const item = map.get(key);
      item.quantity += qty;
      item.total += amount;
      item.transactions += 1;

      if (
        row.payment_method === "현금" ||
        row.payment_method === "계좌" ||
        row.payment_method === "시루"
      ) {
        item.cashGroup += amount;
      } else if (row.payment_method === "카드") {
        item.card += amount;
      }
    }

    return [...map.values()].sort((a, b) =>
      b.total - a.total ||
      b.quantity - a.quantity ||
      a.itemName.localeCompare(b.itemName, "ko")
    );
  }

  function currentDayRows() {
    if (!state.selectedDay) return [];
    return monthRows().filter(row => row.sale_date === state.selectedDay);
  }

  function preferredSelectedDay() {
    const rows = monthRows();

    if (!rows.length) return null;

    const dateSet = new Set(rows.map(row => row.sale_date));
    const currentYmd = `${now.year}-${pad(now.month)}-${pad(now.day)}`;

    if (
      state.year === now.year &&
      state.month === now.month &&
      dateSet.has(currentYmd)
    ) {
      return currentYmd;
    }

    return [...dateSet].sort().reverse()[0] || null;
  }

  function ensureSelectedDay() {
    const rows = monthRows();
    const valid = new Set(rows.map(row => row.sale_date));

    if (!state.selectedDay || !valid.has(state.selectedDay)) {
      state.selectedDay = preferredSelectedDay();
    }
  }

  function formatSelectedDay(dateText) {
    if (!dateText) return "선택된 날짜 없음";

    const [y, m, d] = dateText.split("-").map(Number);
    const weekday = new Intl.DateTimeFormat("ko-KR", {
      weekday: "short",
      timeZone: "UTC"
    }).format(new Date(Date.UTC(y, m - 1, d)));

    return `${m}월 ${d}일 (${weekday})`;
  }

  function setDaySummary() {
    const rows = currentDayRows();
    const summary = summarize(rows);

    $("selectedDayTitle").textContent = formatSelectedDay(state.selectedDay);

    $("sumCashOnly").textContent = won(summary.cashOnly);
    $("sumAccount").textContent = won(summary.account);
    $("sumSiru").textContent = won(summary.siru);
    $("sumCardDetail").textContent = won(summary.card);
    $("sumTotalDetail").textContent = won(summary.total);
  }

  function setQuickSummary() {
    let rows = [];
    let label = "현금계";

    if (state.view === "detail") {
      rows = currentDayRows();
    } else if (state.view === "month") {
      rows = monthRows();
    } else {
      rows = state.rows;
    }

    const summary = summarize(rows);

    $("quickCashLabel").textContent = label;
    $("quickCash").textContent = won(summary.cashGroup);
    $("quickCard").textContent = won(summary.card);
    $("quickTotal").textContent = won(summary.total);
  }

  function setPeriodTitle() {
    if (state.view === "year") {
      $("periodEyebrow").textContent = "조회연도";
      $("periodTitle").textContent = `${state.year}년`;
      return;
    }

    $("periodEyebrow").textContent =
      state.view === "detail" ? "건별 조회월" : "조회월";

    $("periodTitle").textContent =
      `${state.year}년 ${state.month}월`;
  }

  function paymentClass(method) {
    if (method === "시루") return "siru";
    if (method === "카드") return "card";
    return "";
  }

  function renderDayItems() {
    const rows = [...currentDayRows()].sort((a, b) =>
      String(a.sale_time || "").localeCompare(String(b.sale_time || ""))
    );

    $("dayItemsTitle").textContent =
      `${formatSelectedDay(state.selectedDay)} 판매 품목`;

    $("dayItemsCount").textContent = `${rows.length}건`;

    $("dayItemsRows").innerHTML = rows.map(row => `
      <tr>
        <td>${escapeHtml(String(row.sale_time || "").slice(0, 5) || "-")}</td>
        <td class="item">${escapeHtml(row.item_name || "-")}</td>
        <td>
          <span class="payment ${paymentClass(row.payment_method)}">
            ${escapeHtml(row.payment_method)}
          </span>
        </td>
        <td class="center">${Number(row.quantity || 1)}</td>
        <td class="right"><strong>${won(row.amount)}</strong></td>
        <td class="memo">${escapeHtml(row.comment || "")}</td>
      </tr>
    `).join("");

    $("dayItemsEmpty").classList.toggle("hidden", rows.length !== 0);
  }

  function renderDetail() {
    ensureSelectedDay();

    const rows = [...monthRows()].sort((a, b) => {
      const byDate =
        String(b.sale_date).localeCompare(String(a.sale_date));

      return byDate ||
        String(b.sale_time || "").localeCompare(String(a.sale_time || ""));
    });

    $("detailTitle").textContent =
      `${state.year}년 ${state.month}월 전체 건별 매출내역`;

    $("detailSub").textContent =
      "위에는 선택 날짜 판매 품목, 아래에는 해당 월 전체 거래를 표시합니다.";

    $("detailCount").textContent = `${rows.length}건`;

    $("detailRows").innerHTML = rows.map(row => {
      const selected =
        state.selectedDay &&
        row.sale_date === state.selectedDay;

      return `
        <tr
          class="${selected ? "selected-day-row" : ""}"
          data-date="${escapeHtml(row.sale_date)}"
          title="이 날짜의 매출 상세 보기"
        >
          <td><strong>${escapeHtml(row.sale_date)}</strong></td>
          <td>${escapeHtml(String(row.sale_time || "").slice(0, 5) || "-")}</td>
          <td class="item">${escapeHtml(row.item_name || "-")}</td>
          <td>
            <span class="payment ${paymentClass(row.payment_method)}">
              ${escapeHtml(row.payment_method)}
            </span>
          </td>
          <td class="right"><strong>${won(row.amount)}</strong></td>
          <td class="center">${Number(row.quantity || 1)}</td>
          <td class="memo">${escapeHtml(row.comment || "")}</td>
        </tr>
      `;
    }).join("");

    $("detailEmpty").classList.toggle("hidden", rows.length !== 0);

    $$("#detailRows tr[data-date]").forEach(row => {
      row.addEventListener("click", () => {
        state.selectedDay = row.dataset.date;
        render();
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    });

    setDaySummary();
    renderDayItems();
  }

  function renderMonthItems() {
    const items = aggregateItems(monthRows());

    $("monthItemsTitle").textContent =
      `${state.year}년 ${state.month}월 품목별 집계`;

    $("monthItemsCount").textContent =
      `${items.length}품목`;

    $("monthItemsRows").innerHTML = items.map(item => `
      <tr>
        <td class="item">${escapeHtml(item.itemName)}</td>
        <td class="center"><strong>${num(item.quantity)}</strong></td>
        <td class="right">${won(item.cashGroup)}</td>
        <td class="right">${won(item.card)}</td>
        <td class="right"><strong>${won(item.total)}</strong></td>
        <td class="center">${num(item.transactions)}건</td>
      </tr>
    `).join("");
  }

  function renderMonthCalendar() {
    const rows = monthRows();

    $("monthTitle").textContent =
      `${state.year}년 ${state.month}월 매출 달력`;

    const grouped = new Map();

    for (const row of rows) {
      if (!grouped.has(row.sale_date)) {
        grouped.set(row.sale_date, []);
      }

      grouped.get(row.sale_date).push(row);
    }

    const firstDay =
      new Date(Date.UTC(state.year, state.month - 1, 1)).getUTCDay();

    const days =
      new Date(Date.UTC(state.year, state.month, 0)).getUTCDate();

    const cells = [];

    for (let i = 0; i < firstDay; i++) {
      cells.push('<div class="calendar-cell empty-cell"></div>');
    }

    for (let day = 1; day <= days; day++) {
      const date =
        `${state.year}-${pad(state.month)}-${pad(day)}`;

      const dayRows = grouped.get(date) || [];
      const summary = summarize(dayRows);
      const weekday = (firstDay + day - 1) % 7;

      const weekendClass =
        weekday === 0
          ? "sun"
          : weekday === 6
            ? "sat"
            : "";

      const salesClass =
        dayRows.length ? "has-sales" : "";

      cells.push(`
        <div
          class="calendar-cell ${weekendClass} ${salesClass}"
          data-date="${date}"
        >
          <div class="calendar-day">${day}</div>

          ${
            dayRows.length
              ? `
                <div class="calendar-total">${won(summary.total)}</div>
                <div class="calendar-lines">
                  <div class="calendar-line">
                    <span>현금</span>
                    <strong>${won(summary.cashGroup)}</strong>
                  </div>
                  <div class="calendar-line">
                    <span>카드</span>
                    <strong>${won(summary.card)}</strong>
                  </div>
                </div>
              `
              : '<div class="calendar-none">-</div>'
          }
        </div>
      `);
    }

    const used = firstDay + days;
    const trailing = (7 - (used % 7)) % 7;

    for (let i = 0; i < trailing; i++) {
      cells.push('<div class="calendar-cell empty-cell"></div>');
    }

    $("monthCalendar").innerHTML = cells.join("");

    $$(".calendar-cell.has-sales").forEach(cell => {
      cell.addEventListener("click", () => {
        state.selectedDay = cell.dataset.date;
        state.view = "detail";
        render();
      });
    });

    renderMonthItems();
  }

  function renderYearItems() {
    const items = aggregateItems(state.rows);

    $("yearItemsTitle").textContent =
      `${state.year}년 품목별 집계`;

    $("yearItemsCount").textContent =
      `${items.length}품목`;

    $("yearItemsRows").innerHTML = items.map(item => `
      <tr>
        <td class="item">${escapeHtml(item.itemName)}</td>
        <td class="center"><strong>${num(item.quantity)}</strong></td>
        <td class="right">${won(item.cashGroup)}</td>
        <td class="right">${won(item.card)}</td>
        <td class="right"><strong>${won(item.total)}</strong></td>
        <td class="center">${num(item.transactions)}건</td>
      </tr>
    `).join("");
  }

  function renderYearCalendar() {
    $("yearTitle").textContent =
      `${state.year}년 연매출`;

    const cards = [];

    for (let month = 1; month <= 12; month++) {
      const rows = monthRows(month);
      const summary = summarize(rows);

      cards.push(`
        <article
          class="month-card ${rows.length ? "" : "no-sales"}"
          data-month="${month}"
        >
          <div class="month-card-head">
            <strong>${month}월</strong>
            <span class="month-card-count">${rows.length}건</span>
          </div>

          <div class="month-card-total">
            ${won(summary.total)}
          </div>

          <div class="month-card-lines">
            <div class="month-card-line">
              <span>현금</span>
              <strong>${won(summary.cashGroup)}</strong>
            </div>

            <div class="month-card-line">
              <span>카드</span>
              <strong>${won(summary.card)}</strong>
            </div>
          </div>
        </article>
      `);
    }

    $("yearCalendar").innerHTML = cards.join("");

    $$(".month-card").forEach(card => {
      card.addEventListener("click", () => {
        state.month = Number(card.dataset.month);
        state.selectedDay = null;
        ensureSelectedDay();
        state.view = "month";
        render();
      });
    });

    renderYearItems();
  }

  function render() {
    $("detailPanel").classList.toggle("hidden", state.view !== "detail");
    $("detailSummary").classList.toggle("hidden", state.view !== "detail");
    $("dayItemsPanel").classList.toggle("hidden", state.view !== "detail");

    $("monthPanel").classList.toggle("hidden", state.view !== "month");
    $("monthItemsPanel").classList.toggle("hidden", state.view !== "month");

    $("yearPanel").classList.toggle("hidden", state.view !== "year");
    $("yearItemsPanel").classList.toggle("hidden", state.view !== "year");

    for (const button of $$(".tab")) {
      button.classList.toggle(
        "active",
        button.dataset.view === state.view
      );
    }

    setPeriodTitle();

    if (state.view === "detail") {
      renderDetail();
    } else if (state.view === "month") {
      renderMonthCalendar();
    } else {
      renderYearCalendar();
    }

    setQuickSummary();

    $("lastUpdated").textContent =
      `마지막 갱신: ${new Intl.DateTimeFormat("ko-KR", {
        timeZone: "Asia/Seoul",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      }).format(new Date())}`;
  }

  function stepPeriod(delta) {
    if (state.view === "year") {
      state.year += delta;
      state.selectedDay = null;
      loadYear(true);
      return;
    }

    let month = state.month + delta;
    let year = state.year;

    if (month < 1) {
      month = 12;
      year--;
    }

    if (month > 12) {
      month = 1;
      year++;
    }

    state.month = month;
    state.selectedDay = null;

    if (year !== state.year) {
      state.year = year;
      loadYear(true);
    } else {
      ensureSelectedDay();
      render();
    }
  }

  function summaryCardsHtml(rows) {
    const s = summarize(rows);

    return `
      <table class="print-summary-table">
        <thead>
          <tr>
            <th>현금계</th>
            <th>카드</th>
            <th>총매출</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>${won(s.cashGroup)}</td>
            <td>${won(s.card)}</td>
            <td><strong>${won(s.total)}</strong></td>
          </tr>
        </tbody>
      </table>
    `;
  }

  function printItemAggregateTable(items) {
    return `
      <table class="print-data-table">
        <thead>
          <tr>
            <th>판매 품목</th>
            <th>수량</th>
            <th>현금계</th>
            <th>카드</th>
            <th>총매출</th>
            <th>거래건수</th>
          </tr>
        </thead>
        <tbody>
          ${items.map(item => `
            <tr>
              <td>${escapeHtml(item.itemName)}</td>
              <td class="p-center">${num(item.quantity)}</td>
              <td class="p-right">${won(item.cashGroup)}</td>
              <td class="p-right">${won(item.card)}</td>
              <td class="p-right"><strong>${won(item.total)}</strong></td>
              <td class="p-center">${num(item.transactions)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  }

  function buildDailyPrint() {
    const dayRows = [...currentDayRows()].sort((a, b) =>
      String(a.sale_time || "").localeCompare(String(b.sale_time || ""))
    );
    const monthly = [...monthRows()].sort((a, b) =>
      String(a.sale_date).localeCompare(String(b.sale_date)) ||
      String(a.sale_time || "").localeCompare(String(b.sale_time || ""))
    );

    return `
      <div class="print-title">
        <h1>박물관 일매출</h1>
        <p>${state.year}년 ${state.month}월 · ${formatSelectedDay(state.selectedDay)}</p>
      </div>

      ${summaryCardsHtml(dayRows)}

      <h2>선택일 판매 품목 상세</h2>
      <table class="print-data-table">
        <thead>
          <tr>
            <th>시간</th>
            <th>판매 품목</th>
            <th>결제</th>
            <th>수량</th>
            <th>금액</th>
            <th>비고</th>
          </tr>
        </thead>
        <tbody>
          ${dayRows.map(row => `
            <tr>
              <td>${escapeHtml(String(row.sale_time || "").slice(0, 5) || "-")}</td>
              <td>${escapeHtml(row.item_name || "-")}</td>
              <td>${escapeHtml(row.payment_method)}</td>
              <td class="p-center">${Number(row.quantity || 1)}</td>
              <td class="p-right">${won(row.amount)}</td>
              <td>${escapeHtml(row.comment || "")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>

      <h2 class="print-page-section">${state.year}년 ${state.month}월 전체 거래내역</h2>
      <table class="print-data-table">
        <thead>
          <tr>
            <th>날짜</th>
            <th>시간</th>
            <th>판매 품목</th>
            <th>결제</th>
            <th>수량</th>
            <th>금액</th>
            <th>비고</th>
          </tr>
        </thead>
        <tbody>
          ${monthly.map(row => `
            <tr>
              <td>${escapeHtml(row.sale_date)}</td>
              <td>${escapeHtml(String(row.sale_time || "").slice(0, 5) || "-")}</td>
              <td>${escapeHtml(row.item_name || "-")}</td>
              <td>${escapeHtml(row.payment_method)}</td>
              <td class="p-center">${Number(row.quantity || 1)}</td>
              <td class="p-right">${won(row.amount)}</td>
              <td>${escapeHtml(row.comment || "")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  }

  function buildMonthlyPrint() {
    const rows = monthRows();
    const items = aggregateItems(rows);
    const grouped = new Map();

    for (const row of rows) {
      if (!grouped.has(row.sale_date)) grouped.set(row.sale_date, []);
      grouped.get(row.sale_date).push(row);
    }

    const dates = [...grouped.keys()].sort();

    return `
      <div class="print-title">
        <h1>박물관 월매출</h1>
        <p>${state.year}년 ${state.month}월</p>
      </div>

      ${summaryCardsHtml(rows)}

      <h2>품목별 집계</h2>
      ${printItemAggregateTable(items)}

      <h2 class="print-page-section">일자별 매출</h2>
      <table class="print-data-table">
        <thead>
          <tr>
            <th>날짜</th>
            <th>현금계</th>
            <th>카드</th>
            <th>총매출</th>
            <th>건수</th>
          </tr>
        </thead>
        <tbody>
          ${dates.map(date => {
            const dayRows = grouped.get(date);
            const s = summarize(dayRows);

            return `
              <tr>
                <td>${escapeHtml(date)}</td>
                <td class="p-right">${won(s.cashGroup)}</td>
                <td class="p-right">${won(s.card)}</td>
                <td class="p-right"><strong>${won(s.total)}</strong></td>
                <td class="p-center">${dayRows.length}</td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    `;
  }

  function buildAnnualPrint() {
    const items = aggregateItems(state.rows);

    return `
      <div class="print-title">
        <h1>박물관 연매출</h1>
        <p>${state.year}년</p>
      </div>

      ${summaryCardsHtml(state.rows)}

      <h2>월별 매출</h2>
      <table class="print-data-table">
        <thead>
          <tr>
            <th>월</th>
            <th>현금계</th>
            <th>카드</th>
            <th>총매출</th>
            <th>건수</th>
          </tr>
        </thead>
        <tbody>
          ${Array.from({ length: 12 }, (_, i) => i + 1).map(month => {
            const rows = monthRows(month);
            const s = summarize(rows);

            return `
              <tr>
                <td>${month}월</td>
                <td class="p-right">${won(s.cashGroup)}</td>
                <td class="p-right">${won(s.card)}</td>
                <td class="p-right"><strong>${won(s.total)}</strong></td>
                <td class="p-center">${rows.length}</td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>

      <h2 class="print-page-section">연간 품목별 집계</h2>
      ${printItemAggregateTable(items)}
    `;
  }

  function printCurrentView() {
    let content = "";

    if (state.view === "detail") {
      content = buildDailyPrint();
    } else if (state.view === "month") {
      content = buildMonthlyPrint();
    } else {
      content = buildAnnualPrint();
    }

    $("printSheet").innerHTML = `
      <div class="print-document">
        ${content}
        <div class="print-footer">
          출력일시: ${new Intl.DateTimeFormat("ko-KR", {
            timeZone: "Asia/Seoul",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit"
          }).format(new Date())}
        </div>
      </div>
    `;

    window.print();
  }

  function bindEvents() {
    for (const button of $$(".tab")) {
      button.addEventListener("click", () => {
        state.view = button.dataset.view;

        if (state.view === "detail") {
          ensureSelectedDay();
        }

        render();
      });
    }

    $("pinForm").addEventListener("submit", event => {
      event.preventDefault();

      const pin = $("pinInput").value.trim();

      if (pin.length < 6) {
        $("pinMessage").textContent = "PIN을 입력하세요.";
        return;
      }

      login(pin);
    });

    $("logoutBtn").addEventListener("click", logout);
    $("prevBtn").addEventListener("click", () => stepPeriod(-1));
    $("nextBtn").addEventListener("click", () => stepPeriod(1));
    $("printBtn").addEventListener("click", printCurrentView);

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && getToken()) {
        loadYear();
      }
    });
  }

  async function start() {
    try {
      initClient();
      bindEvents();
      render();

      if (!getToken()) {
        showPin();
        return;
      }

      hidePin();
      await loadYear(true);
      startPolling();
    } catch (error) {
      showPin(cleanError(error));
    }
  }

  start();
})();
