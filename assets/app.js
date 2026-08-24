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

  const pad = n => String(n).padStart(2, "0");

  function kstParts() {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date());

    const obj = {};
    for (const p of parts) {
      if (p.type !== "literal") obj[p.type] = p.value;
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
    view: "day",
    year: now.year,
    month: now.month,
    day: now.ymd,
    rows: [],
    loading: false,
    pollTimer: null
  };

  let client = null;

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

  function initYearOptions() {
    const select = $("yearInput");
    select.innerHTML = "";

    const first = Math.min(Number(cfg.FIRST_YEAR || 2026), now.year);
    const last = now.year + 5;

    for (let year = last; year >= first; year--) {
      const option = document.createElement("option");
      option.value = String(year);
      option.textContent = `${year}년`;
      select.appendChild(option);
    }

    select.value = String(state.year);
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
    } catch (err) {
      let message = cleanError(err);

      if (
        message.includes("RPC를 찾지 못했습니다") ||
        message.includes("권한이 없습니다")
      ) {
        const health = await checkRpcHealth();
        if (!health.ok) {
          const healthMessage = cleanError(health.error);
          message += ` / 연결진단: ${healthMessage}`;
        }
      }

      console.error("KCEM PIN login error:", err);
      showPin(message);
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
    } catch (_) {
      // 서버 로그아웃 실패 시에도 이 기기의 토큰은 제거
    }

    clearAccess();
    stopPolling();
    state.rows = [];
    render();
    showPin("이 기기의 조회 인증을 해제했습니다.");
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
      message.includes("Could not find the function") ||
      message.includes("PGRST202") ||
      message.includes("404")
    ) {
      return "Supabase에서 PIN 인증 RPC를 찾지 못했습니다. REPAIR_AND_VERIFY_PIN_v1.0.1.sql을 실행한 뒤 다시 시도하세요.";
    }

    if (
      message.includes("permission denied") ||
      message.includes("42501")
    ) {
      return "PIN 인증 RPC 실행 권한이 없습니다. 복구 SQL을 실행해 권한을 다시 설정하세요.";
    }

    if (message.includes("조회 인증이 만료")) {
      return "조회 인증이 만료되었습니다. PIN을 다시 입력하세요.";
    }

    if (message.includes("조회 PIN이 아직 설정되지")) {
      return "Supabase에 조회 PIN이 아직 설정되지 않았습니다.";
    }

    if (message.includes("PIN이 올바르지")) {
      return "PIN이 올바르지 않습니다.";
    }

    return message;
  }

  async function checkRpcHealth() {
    try {
      const { data, error } = await client.rpc("kcem_public_health");
      if (error) return { ok: false, error };
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error };
    }
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
      $("statusBadge").textContent = "연결됨";
      hidePin();
      render();
    } catch (err) {
      const msg = cleanError(err);

      if (
        msg.includes("인증") ||
        msg.includes("PIN")
      ) {
        clearAccess();
        stopPolling();
        showPin(msg);
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

  function summarize(rows) {
    const out = {
      account: 0,
      cash: 0,
      card: 0,
      total: 0
    };

    for (const row of rows) {
      const amount = Number(row.amount || 0);

      if (row.payment_method === "계좌") out.account += amount;
      if (row.payment_method === "현금") out.cash += amount;
      if (row.payment_method === "카드") out.card += amount;

      out.total += amount;
    }

    return out;
  }

  function setSummary(rows) {
    const s = summarize(rows);

    $("sumAccount").textContent = won(s.account);
    $("sumCash").textContent = won(s.cash);
    $("sumCard").textContent = won(s.card);
    $("sumTotal").textContent = won(s.total);
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, ch => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[ch]));
  }

  function dayLabel(ymd) {
    const d = new Date(`${ymd}T00:00:00Z`);

    return new Intl.DateTimeFormat("ko-KR", {
      timeZone: "UTC",
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "short"
    }).format(d);
  }

  function renderDay() {
    const rows = state.rows
      .filter(r => r.sale_date === state.day)
      .sort((a, b) =>
        String(b.sale_time || "").localeCompare(
          String(a.sale_time || "")
        )
      );

    $("dayTitle").textContent = dayLabel(state.day);
    $("dayCount").textContent = `${rows.length}건`;

    $("dayRows").innerHTML = rows.map(row => `
      <tr>
        <td>${escapeHtml(String(row.sale_time || "").slice(0, 5) || "-")}</td>
        <td><span class="payment">${escapeHtml(row.payment_method)}</span></td>
        <td class="right"><strong>${won(row.amount)}</strong></td>
        <td class="item">${escapeHtml(row.item_name || "-")}</td>
        <td class="center">${Number(row.quantity || 1)}</td>
        <td class="memo">${escapeHtml(row.comment || "")}</td>
      </tr>
    `).join("");

    $("dayEmpty").classList.toggle(
      "hidden",
      rows.length !== 0
    );

    setSummary(rows);
  }

  function renderMonth() {
    const monthRows = state.rows.filter(
      row => Number(row.sale_date.slice(5, 7)) === state.month
    );

    const grouped = new Map();

    for (const row of monthRows) {
      if (!grouped.has(row.sale_date)) {
        grouped.set(row.sale_date, []);
      }
      grouped.get(row.sale_date).push(row);
    }

    const days = [...grouped.keys()].sort();

    $("monthTitle").textContent =
      `${state.year}년 ${state.month}월`;

    $("monthCount").textContent =
      `${days.length}일`;

    $("monthRows").innerHTML = days.map(day => {
      const rows = grouped.get(day);
      const s = summarize(rows);

      return `
        <tr>
          <td><strong>${escapeHtml(day)}</strong></td>
          <td class="right">${won(s.account)}</td>
          <td class="right">${won(s.cash)}</td>
          <td class="right">${won(s.card)}</td>
          <td class="right"><strong>${won(s.total)}</strong></td>
          <td class="center">${rows.length}건</td>
        </tr>
      `;
    }).join("");

    setSummary(monthRows);
  }

  function renderYear() {
    const months = Array.from(
      { length: 12 },
      (_, i) => i + 1
    );

    $("yearTitle").textContent =
      `${state.year}년 연매출`;

    $("yearRows").innerHTML = months.map(month => {
      const rows = state.rows.filter(
        row => Number(row.sale_date.slice(5, 7)) === month
      );

      const s = summarize(rows);

      return `
        <tr>
          <td><strong>${month}월</strong></td>
          <td class="right">${won(s.account)}</td>
          <td class="right">${won(s.cash)}</td>
          <td class="right">${won(s.card)}</td>
          <td class="right"><strong>${won(s.total)}</strong></td>
          <td class="center">${rows.length}건</td>
        </tr>
      `;
    }).join("");

    const y = summarize(state.rows);

    $("yearAccount").textContent = won(y.account);
    $("yearCash").textContent = won(y.cash);
    $("yearCard").textContent = won(y.card);
    $("yearTotal").textContent = won(y.total);
    $("yearCount").textContent = `${state.rows.length}건`;

    setSummary(state.rows);
  }

  function render() {
    $("dayPanel").classList.toggle(
      "hidden",
      state.view !== "day"
    );

    $("monthPanel").classList.toggle(
      "hidden",
      state.view !== "month"
    );

    $("yearPanel").classList.toggle(
      "hidden",
      state.view !== "year"
    );

    $("dayBox").classList.toggle(
      "hidden",
      state.view !== "day"
    );

    $("monthBox").classList.toggle(
      "hidden",
      state.view !== "month"
    );

    for (const button of $$(".tab")) {
      button.classList.toggle(
        "active",
        button.dataset.view === state.view
      );
    }

    $("yearInput").value = String(state.year);
    $("monthInput").value = String(state.month);
    $("dayInput").value = state.day;

    if (state.view === "day") renderDay();
    if (state.view === "month") renderMonth();
    if (state.view === "year") renderYear();

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

  async function setYear(year) {
    state.year = Number(year);

    if (state.view === "day") {
      const month = Number(state.day.slice(5, 7));
      const day = Number(state.day.slice(8, 10));

      const lastDay =
        new Date(Date.UTC(state.year, month, 0)).getUTCDate();

      state.day =
        `${state.year}-${pad(month)}-${pad(Math.min(day, lastDay))}`;
    }

    await loadYear(true);
  }

  function stepPeriod(delta) {
    if (state.view === "day") {
      const [y, m, d] = state.day.split("-").map(Number);
      const date = new Date(Date.UTC(y, m - 1, d));

      date.setUTCDate(date.getUTCDate() + delta);

      const nextYear = date.getUTCFullYear();
      const nextMonth = date.getUTCMonth() + 1;
      const nextDay = date.getUTCDate();

      state.day =
        `${nextYear}-${pad(nextMonth)}-${pad(nextDay)}`;

      state.month = nextMonth;

      if (nextYear !== state.year) {
        state.year = nextYear;
        loadYear(true);
      } else {
        render();
      }

      return;
    }

    if (state.view === "month") {
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

      if (year !== state.year) {
        state.year = year;
        loadYear(true);
      } else {
        render();
      }

      return;
    }

    state.year += delta;
    loadYear(true);
  }

  function bindEvents() {
    for (const button of $$(".tab")) {
      button.addEventListener("click", () => {
        state.view = button.dataset.view;
        render();
      });
    }

    $("pinForm").addEventListener("submit", event => {
      event.preventDefault();

      const pin = $("pinInput").value.trim();

      if (pin.length < 6) {
        $("pinMessage").textContent =
          "PIN을 입력하세요.";
        return;
      }

      login(pin);
    });

    $("logoutBtn").addEventListener("click", logout);

    $("yearInput").addEventListener("change", event => {
      setYear(event.target.value);
    });

    $("monthInput").addEventListener("change", event => {
      state.month = Number(event.target.value);
      render();
    });

    $("dayInput").addEventListener("change", event => {
      if (!event.target.value) return;

      const value = event.target.value;
      const year = Number(value.slice(0, 4));

      state.day = value;
      state.month = Number(value.slice(5, 7));

      if (year !== state.year) {
        state.year = year;
        loadYear(true);
      } else {
        render();
      }
    });

    $("prevBtn").addEventListener(
      "click",
      () => stepPeriod(-1)
    );

    $("nextBtn").addEventListener(
      "click",
      () => stepPeriod(1)
    );

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && getToken()) {
        loadYear();
      }
    });
  }

  async function start() {
    try {
      initClient();
      initYearOptions();
      bindEvents();
      render();

      if (!getToken()) {
        showPin();
        return;
      }

      hidePin();
      await loadYear(true);
      startPolling();
    } catch (err) {
      showPin(cleanError(err));
    }
  }

  start();
})();
