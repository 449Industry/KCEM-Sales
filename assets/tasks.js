(() => {
  const cfg = window.KCEM_CONFIG || {};
  const $ = id => document.getElementById(id);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  const TOKEN_KEY = "kcem_public_access_token";
  const MODULE_KEY = "kcem_current_module";

  let client = null;
  let allMembers = [];
  let activeMembers = [];
  let tasks = [];
  let selectedPage = "ALL"; // ALL | member uuid | SEARCH | ARCHIVE
  let draggedTaskId = null;
  let pollTimer = null;
  let taskApiReady = true;

  const allSort = {
    key: "due",
    dir: "asc"
  };

  const searchState = {
    text: "",
    tags: new Set()
  };

  let editQtyCondition = "EXACT";
  let editAssigneeId = "";

  const CATEGORY_RULES = [
    {
      canonical: "3D프린트",
      patterns: [
        /3\s*d\s*프린트/gi, /3\s*d\s*프린팅/gi, /3\s*d\s*출력/gi,
        /\b3d\b/gi, /프린팅/gi, /3d프린터/gi
      ],
      keywords: ["3d", "3d프린트", "3d 프린트", "3d출력", "3d 출력", "프린팅", "3d프린터"]
    },
    {
      canonical: "레이저커팅",
      patterns: [/레이저\s*커팅/gi, /레이저\s*컷팅/gi, /레이저\s*가공/gi],
      keywords: ["레이저커팅", "레이저 커팅", "레이저컷팅", "레이저 가공"]
    },
    {
      canonical: "제작",
      patterns: [/제작/gi, /조립/gi, /가공/gi],
      keywords: ["제작", "조립", "가공"]
    },
    {
      canonical: "구매",
      patterns: [/구매/gi, /구입/gi, /발주/gi, /주문/gi],
      keywords: ["구매", "구입", "발주", "주문"]
    },
    {
      canonical: "정리",
      patterns: [/정리/gi, /정돈/gi, /청소/gi],
      keywords: ["정리", "정돈", "청소"]
    },
    {
      canonical: "예약",
      patterns: [/예약/gi],
      keywords: ["예약"]
    },
    {
      canonical: "강사",
      patterns: [/강사/gi, /수업/gi, /출강/gi],
      keywords: ["강사", "수업", "출강"]
    }
  ];

  const COLOR_RULES = [
    ["흰색", ["흰색", "하얀색", "화이트", "white"]],
    ["검정", ["검정", "검은색", "블랙", "black"]],
    ["빨강", ["빨강", "빨간색", "레드", "red"]],
    ["파랑", ["파랑", "파란색", "블루", "blue"]],
    ["하늘색", ["하늘색", "스카이", "sky"]],
    ["노랑", ["노랑", "노란색", "옐로우", "yellow"]],
    ["초록", ["초록", "녹색", "그린", "green"]],
    ["분홍", ["분홍", "핑크", "pink"]],
    ["보라", ["보라", "퍼플", "purple"]],
    ["주황", ["주황", "오렌지", "orange"]],
    ["회색", ["회색", "그레이", "gray", "grey"]],
    ["갈색", ["갈색", "브라운", "brown"]]
  ];

  const TITLE_CANONICAL_RULES = [
    ["이니셜 키링", ["이니셜키링", "이니셜 키링", "이니셜 키 링"]],
    ["키링", ["키링", "키 링"]]
  ];

  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[ch]));

  const pad = n => String(n).padStart(2, "0");

  function token() {
    return localStorage.getItem(TOKEN_KEY) || "";
  }

  function setModule(module) {
    const isTasks = module === "tasks";
    $("salesApp").classList.toggle("hidden", isTasks);
    $("taskApp").classList.toggle("hidden", !isTasks);
    $$(".module-tab").forEach(btn =>
      btn.classList.toggle("active", btn.dataset.module === module)
    );
    localStorage.setItem(MODULE_KEY, module);

    if (isTasks) {
      loadAll();
      startPolling();
    } else {
      stopPolling();
    }
  }

  function rpcErrorText(error) {
    const text = [error?.message, error?.details, error?.hint, error?.code]
      .filter(Boolean).join(" / ");

    if (
      text.includes("kcem_tasks_list_v2") ||
      text.includes("PGRST202") ||
      text.includes("Could not find the function")
    ) {
      taskApiReady = false;
      $("taskSetupNotice").classList.remove("hidden");
      return "업무공유 v1.6.0 DB 마이그레이션 SQL을 먼저 실행하세요.";
    }

    if (text.includes("인증이 만료") || text.includes("인증이 필요")) {
      return "공용 PIN 인증이 필요합니다. 페이지를 새로고침해 PIN을 입력하세요.";
    }

    return text || "업무 처리 중 오류가 발생했습니다.";
  }

  function memberName(id) {
    return allMembers.find(m => m.member_id === id)?.member_name || "-";
  }

  function activeMember(id) {
    return activeMembers.find(m => m.member_id === id) || null;
  }

  function formatDate(value) {
    if (!value) return "-";
    const d = new Date(`${String(value).slice(0, 10)}T00:00:00`);
    if (Number.isNaN(d.getTime())) return "-";
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  function formatDateTime(value) {
    if (!value) return "-";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "-";
    return new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }).format(d);
  }

  function dateOnly(value) {
    return value ? String(value).slice(0, 10) : "";
  }

  function todayKst() {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date());
    const obj = {};
    parts.forEach(p => {
      if (p.type !== "literal") obj[p.type] = p.value;
    });
    return `${obj.year}-${obj.month}-${obj.day}`;
  }

  function isApprovedRecent(task) {
    if (task.status !== "APPROVED" || !task.approved_at) return false;
    const approved = new Date(task.approved_at).getTime();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    return Date.now() - approved < sevenDays;
  }

  function isActiveTask(task) {
    return task.status !== "APPROVED" || isApprovedRecent(task);
  }

  function statusLabel(status) {
    if (status === "IN_PROGRESS") return "진행중";
    if (status === "DONE") return "완료·승인대기";
    if (status === "APPROVED") return "승인완료";
    return "요청";
  }

  function statusRank(status) {
    return status === "IN_PROGRESS" ? 0
      : status === "REQUESTED" ? 1
      : status === "DONE" ? 2
      : 3;
  }

  function qtyText(task) {
    if (!task.quantity) return "";
    const suffix = task.quantity_condition === "AT_LEAST" ? "개 이상"
      : task.quantity_condition === "AT_MOST" ? "개 이하"
      : "개";
    return `${Number(task.quantity).toLocaleString("ko-KR")}${suffix}`;
  }

  function dueClass(task) {
    if (!task.due_date || ["DONE", "APPROVED"].includes(task.status)) return "";
    const today = todayKst();
    if (task.due_date < today) return "overdue";
    const diff = (
      new Date(`${task.due_date}T00:00:00`).getTime()
      - new Date(`${today}T00:00:00`).getTime()
    ) / 86400000;
    return diff <= 3 ? "due-soon" : "";
  }

  function normalizeCompact(text) {
    let s = String(text || "")
      .toLocaleLowerCase("ko")
      .replace(/[·ㆍ,_\-./()[\]{}'"]/g, "")
      .replace(/\s+/g, "");

    TITLE_CANONICAL_RULES.forEach(([canonical, variants]) => {
      variants.forEach(v => {
        const nv = v.toLocaleLowerCase("ko").replace(/\s+/g, "");
        if (s.includes(nv)) {
          s = s.replaceAll(nv, canonical.toLocaleLowerCase("ko").replace(/\s+/g, ""));
        }
      });
    });

    CATEGORY_RULES.forEach(rule => {
      rule.keywords.forEach(v => {
        const nv = v.toLocaleLowerCase("ko").replace(/\s+/g, "");
        if (s.includes(nv)) {
          s = s.replaceAll(nv, rule.canonical.toLocaleLowerCase("ko"));
        }
      });
    });

    return s;
  }

  function detectCategory(raw) {
    const compact = normalizeCompact(raw);

    for (const rule of CATEGORY_RULES) {
      if (
        rule.keywords.some(k =>
          compact.includes(normalizeCompact(k))
        )
      ) {
        return rule.canonical;
      }
    }

    return "기타";
  }

  function removeCategoryText(text, category) {
    let out = text;
    const rule = CATEGORY_RULES.find(r => r.canonical === category);
    if (rule) {
      rule.patterns.forEach(pattern => {
        out = out.replace(pattern, " ");
      });
    }
    return out;
  }

  function detectColor(raw) {
    const lower = String(raw || "").toLocaleLowerCase("ko");
    for (const [canonical, variants] of COLOR_RULES) {
      if (variants.some(v => lower.includes(v.toLocaleLowerCase("ko")))) {
        return canonical;
      }
    }
    return "";
  }

  function removeColorText(text, color) {
    if (!color) return text;
    let out = text;
    const rule = COLOR_RULES.find(([canonical]) => canonical === color);
    if (rule) {
      rule[1].forEach(v => {
        out = out.replace(new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ");
      });
    }
    return out;
  }

  function detectQuantity(raw) {
    const text = String(raw || "").replace(/,/g, "");

    let match = text.match(/(\d+)\s*개\s*(이상|이하|정도|가량)?/i);
    if (match) {
      return {
        quantity: Number(match[1]),
        condition: match[2] === "이상" ? "AT_LEAST"
          : match[2] === "이하" ? "AT_MOST"
          : "EXACT",
        matched: match[0]
      };
    }

    match = text.match(/총\s*(\d+)\s*개/i);
    if (match) {
      return {
        quantity: Number(match[1]),
        condition: "EXACT",
        matched: match[0]
      };
    }

    return { quantity: null, condition: "EXACT", matched: "" };
  }

  function detectDueDate(raw) {
    const text = String(raw || "");
    const now = new Date();
    const currentYear = Number(new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Seoul",
      year: "numeric"
    }).format(now));

    let m = text.match(/(20\d{2})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
    let year, month, day, matched = "";

    if (m) {
      year = Number(m[1]);
      month = Number(m[2]);
      day = Number(m[3]);
      matched = m[0];
    } else {
      m = text.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
      if (!m) return { dueDate: "", matched: "" };

      year = currentYear;
      month = Number(m[1]);
      day = Number(m[2]);
      matched = m[0];

      const candidate = new Date(year, month - 1, day);
      const today = new Date(
        Number(todayKst().slice(0, 4)),
        Number(todayKst().slice(5, 7)) - 1,
        Number(todayKst().slice(8, 10))
      );

      if (candidate.getTime() < today.getTime() - 7 * 86400000) {
        year += 1;
      }
    }

    const dueDate = `${year}-${pad(month)}-${pad(day)}`;
    return { dueDate, matched };
  }

  function removeMemberNames(text) {
    let out = text;
    activeMembers.forEach(member => {
      const escaped = String(member.member_name || "")
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (escaped) {
        out = out.replace(new RegExp(`${escaped}\\s*(담당)?`, "gi"), " ");
      }
    });
    return out;
  }

  function cleanTaskName(raw, category, color, qtyInfo, dueInfo) {
    let out = String(raw || "");

    out = removeCategoryText(out, category);
    out = removeColorText(out, color);
    out = removeMemberNames(out);

    if (qtyInfo.matched) {
      out = out.replace(qtyInfo.matched, " ");
    }

    if (dueInfo.matched) {
      out = out.replace(dueInfo.matched, " ");
    }

    out = out
      .replace(/까지\s*(완료|해줘|해주세요|필요|요청)?/gi, " ")
      .replace(/완료\s*(해줘|해주세요)?/gi, " ")
      .replace(/담당/gi, " ")
      .replace(/요청/gi, " ")
      .replace(/필요/gi, " ")
      .replace(/해줘|해주세요|부탁/gi, " ")
      .replace(/[.,/|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!out) out = "업무";

    // Canonicalize common product names without destroying user wording.
    TITLE_CANONICAL_RULES.forEach(([canonical, variants]) => {
      variants.forEach(v => {
        const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        out = out.replace(new RegExp(escaped, "gi"), canonical);
      });
    });

    return out;
  }

  function buildTags(category, title, color) {
    const tags = new Set();

    if (category && category !== "기타") tags.add(category);
    if (color) tags.add(color);

    const normalizedTitle = String(title || "").trim();
    if (normalizedTitle) {
      tags.add(normalizedTitle);

      const tokens = normalizedTitle
        .split(/\s+/)
        .map(t => t.trim())
        .filter(t => t.length >= 2);

      tokens.forEach(t => tags.add(t));

      TITLE_CANONICAL_RULES.forEach(([canonical, variants]) => {
        if (
          variants.some(v =>
            normalizeCompact(normalizedTitle).includes(normalizeCompact(v))
          )
        ) {
          tags.add(canonical);
        }
      });

      if (normalizeCompact(normalizedTitle).includes("키링")) {
        tags.add("키링");
      }
    }

    return [...tags].slice(0, 20);
  }

  function parseNaturalTask(raw) {
    const category = detectCategory(raw);
    const color = detectColor(raw);
    const qtyInfo = detectQuantity(raw);
    const dueInfo = detectDueDate(raw);
    const title = cleanTaskName(raw, category, color, qtyInfo, dueInfo);
    const tags = buildTags(category, title, color);

    return {
      rawText: String(raw || "").trim(),
      category,
      title,
      color,
      quantity: qtyInfo.quantity,
      quantityCondition: qtyInfo.condition,
      dueDate: dueInfo.dueDate,
      tags
    };
  }

  function renderPrimaryTabs() {
    const staticLeft = `
      <button type="button" class="task-primary-tab ${selectedPage === "ALL" ? "active" : ""}" data-page="ALL">전체</button>
    `;

    const memberButtons = activeMembers.map(m =>
      `<button type="button" class="task-primary-tab ${selectedPage === m.member_id ? "active" : ""}" data-page="${m.member_id}">${escapeHtml(m.member_name)}</button>`
    ).join("");

    const staticRight = `
      <button type="button" class="task-primary-tab utility ${selectedPage === "SEARCH" ? "active" : ""}" data-page="SEARCH">검색</button>
      <button type="button" class="task-primary-tab utility ${selectedPage === "ARCHIVE" ? "active" : ""}" data-page="ARCHIVE">완료목록</button>
    `;

    $("taskPrimaryTabs").innerHTML = staticLeft + memberButtons + staticRight;

    $$(".task-primary-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        selectedPage = btn.dataset.page;
        renderPrimaryTabs();
        renderTaskView();
      });
    });
  }

  function selectedMemberTaskPage() {
    return activeMember(selectedPage);
  }

  function renderEntryPanel() {
    const member = selectedMemberTaskPage();
    const visible = Boolean(member);

    $("taskEntryPanel").classList.toggle("hidden", !visible);

    if (!visible) return;

    $("taskEntryAssigneeLabel").textContent = `${member.member_name} 담당 업무 등록`;
  }

  function previewNaturalInput() {
    const raw = $("taskNaturalInput").value.trim();
    if (!raw) {
      $("taskParsePreview").classList.add("hidden");
      $("taskParsePreview").innerHTML = "";
      return null;
    }

    const parsed = parseNaturalTask(raw);

    const parts = [
      `<span><em>항목</em><strong>${escapeHtml(parsed.category)} ${escapeHtml(parsed.title)}</strong></span>`
    ];

    if (parsed.color) {
      parts.push(`<span><em>색상</em>${escapeHtml(parsed.color)}</span>`);
    }

    if (parsed.quantity) {
      const suffix = parsed.quantityCondition === "AT_LEAST" ? "개 이상"
        : parsed.quantityCondition === "AT_MOST" ? "개 이하"
        : "개";
      parts.push(`<span><em>수량</em>${Number(parsed.quantity).toLocaleString("ko-KR")}${suffix}</span>`);
    }

    if (parsed.dueDate) {
      parts.push(`<span><em>완료요청</em>${formatDate(parsed.dueDate)}</span>`);
    }

    $("taskParsePreview").innerHTML = parts.join("");
    $("taskParsePreview").classList.remove("hidden");
    return parsed;
  }

  async function loadMembers() {
    const { data, error } = await client.rpc("kcem_tasks_members", {
      p_token: token(),
      p_include_inactive: true
    });

    if (error) throw error;

    allMembers = Array.isArray(data) ? data : [];
    activeMembers = allMembers.filter(m => m.is_active);

    if (
      selectedPage !== "ALL" &&
      selectedPage !== "SEARCH" &&
      selectedPage !== "ARCHIVE" &&
      !activeMember(selectedPage)
    ) {
      selectedPage = "ALL";
    }

    renderPrimaryTabs();
    renderMemberManage();
  }

  async function loadTasks() {
    const { data, error } = await client.rpc("kcem_tasks_list_v2", {
      p_token: token()
    });

    if (error) throw error;

    tasks = Array.isArray(data) ? data : [];
    renderTaskView();

    $("taskLastUpdated").textContent =
      `마지막 갱신: ${new Intl.DateTimeFormat("ko-KR", {
        timeZone: "Asia/Seoul",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      }).format(new Date())}`;
  }

  async function loadAll() {
    if (!token() || !client) return;

    try {
      taskApiReady = true;
      $("taskSetupNotice").classList.add("hidden");
      await loadMembers();
      await loadTasks();
      $("taskEntryMessage").textContent = "";
    } catch (error) {
      $("taskEntryMessage").textContent = rpcErrorText(error);
      console.error(error);
    }
  }

  function sortValue(task, key) {
    if (key === "status") return statusRank(task.status);
    if (key === "category") return task.category || "";
    if (key === "title") return task.title || "";
    if (key === "assignee") return task.assigned_name || "";
    if (key === "created") return task.created_at || "";
    if (key === "due") return task.due_date || "9999-12-31";
    return "";
  }

  function activeTasks() {
    return tasks.filter(isActiveTask);
  }

  function sortedAllRows() {
    const rows = activeTasks().slice();
    const collator = new Intl.Collator("ko");

    rows.sort((a, b) => {
      const av = sortValue(a, allSort.key);
      const bv = sortValue(b, allSort.key);

      let result = 0;
      if (typeof av === "number" && typeof bv === "number") {
        result = av - bv;
      } else {
        result = collator.compare(String(av), String(bv));
      }

      if (result === 0) {
        result = String(b.created_at || "").localeCompare(String(a.created_at || ""));
      }

      return allSort.dir === "asc" ? result : -result;
    });

    return rows;
  }

  function taskTitleLine(task) {
    return `${escapeHtml(task.category || "기타")} ${escapeHtml(task.title || "업무")}`;
  }

  function renderAllView() {
    const rows = sortedAllRows();

    $("taskAllRows").innerHTML = rows.map(task => `
      <tr class="task-list-row ${task.status === "APPROVED" ? "approved-row" : ""}" data-open-task="${task.task_id}">
        <td><span class="list-status status-${String(task.status).toLowerCase()}">${statusLabel(task.status)}</span></td>
        <td><strong>${escapeHtml(task.category || "기타")}</strong></td>
        <td>
          <div class="task-list-title">${escapeHtml(task.title || "업무")}</div>
          <div class="task-list-tags">
            ${(task.tags || []).slice(0, 4).map(tag => `<span>${escapeHtml(tag)}</span>`).join("")}
          </div>
        </td>
        <td>${escapeHtml(task.assigned_name || "-")}</td>
        <td>${formatDateTime(task.created_at)}</td>
        <td class="${dueClass(task)}">${task.due_date ? formatDate(task.due_date) : "-"}</td>
      </tr>
    `).join("");

    $("taskAllEmpty").classList.toggle("hidden", rows.length !== 0);

    $$(".task-sort-head").forEach(btn => {
      const arrow = btn.querySelector("span");
      arrow.textContent = btn.dataset.sort === allSort.key
        ? (allSort.dir === "asc" ? "↑" : "↓")
        : "";
    });

    bindOpenTaskRows();
    $("taskVisibleSummary").textContent = `활성 업무 ${rows.length}건`;
  }

  function personTasks(memberId) {
    return tasks.filter(task =>
      task.assigned_to === memberId &&
      isActiveTask(task)
    );
  }

  function kanbanCard(task) {
    const approved = task.status === "APPROVED";
    const classes = [
      "kanban-card",
      approved ? "approved" : "",
      dueClass(task)
    ].filter(Boolean).join(" ");

    const meta = [];
    if (task.color) meta.push(task.color);
    if (task.quantity) meta.push(qtyText(task));
    if (task.due_date) meta.push(`${formatDate(task.due_date)}까지`);

    const approveButton = task.status === "DONE"
      ? `<button type="button" class="card-approve-btn" data-approve="${task.task_id}">승인</button>`
      : "";

    return `
      <article class="${classes}" draggable="${approved ? "false" : "true"}" data-task-id="${task.task_id}">
        <div class="kanban-card-top">
          <span class="kanban-category">${escapeHtml(task.category || "기타")}</span>
          ${task.due_date ? `<span class="kanban-due ${dueClass(task)}">${formatDate(task.due_date)}</span>` : ""}
        </div>

        <h3>${escapeHtml(task.title || "업무")}</h3>

        ${meta.length ? `<div class="kanban-meta">${meta.map(x => `<span>${escapeHtml(x)}</span>`).join("")}</div>` : ""}

        <div class="kanban-card-foot">
          <span>${approved ? `승인 ${formatDateTime(task.approved_at)}` : `요청 ${formatDateTime(task.created_at)}`}</span>
          ${approveButton}
        </div>
      </article>
    `;
  }

  function renderPersonView() {
    const member = selectedMemberTaskPage();
    if (!member) return;

    const rows = personTasks(member.member_id);

    const requested = rows.filter(t => t.status === "REQUESTED");
    const progress = rows.filter(t => t.status === "IN_PROGRESS");
    const done = rows.filter(t => t.status === "DONE" || t.status === "APPROVED");

    const sortKanban = arr => arr.slice().sort((a, b) => {
      const ad = a.due_date || "9999-12-31";
      const bd = b.due_date || "9999-12-31";
      return ad.localeCompare(bd) ||
        String(b.created_at).localeCompare(String(a.created_at));
    });

    $("requestedList").innerHTML = sortKanban(requested).map(kanbanCard).join("")
      || '<div class="kanban-empty">요청 업무 없음</div>';
    $("progressList").innerHTML = sortKanban(progress).map(kanbanCard).join("")
      || '<div class="kanban-empty">진행중 업무 없음</div>';
    $("doneList").innerHTML = sortKanban(done).map(kanbanCard).join("")
      || '<div class="kanban-empty">완료 업무 없음</div>';

    $("requestedCount").textContent = requested.length;
    $("progressCount").textContent = progress.length;
    $("doneCount").textContent = done.length;

    bindKanban();
    $("taskVisibleSummary").textContent = `${member.member_name} 업무 ${rows.length}건`;
  }

  function allTags() {
    const counts = new Map();

    tasks.forEach(task => {
      const tags = new Set([
        ...(task.tags || []),
        task.category,
        task.color
      ].filter(Boolean));

      tags.forEach(tag => {
        counts.set(tag, (counts.get(tag) || 0) + 1);
      });
    });

    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko"));
  }

  function searchMatches(task) {
    const q = normalizeCompact(searchState.text);

    const taskTags = [
      ...(task.tags || []),
      task.category,
      task.title,
      task.color,
      task.assigned_name,
      task.description
    ].filter(Boolean);

    const haystack = normalizeCompact(taskTags.join(" "));

    if (q && !haystack.includes(q)) return false;

    for (const tag of searchState.tags) {
      if (!haystack.includes(normalizeCompact(tag))) return false;
    }

    return true;
  }

  function searchPrioritySort(a, b) {
    const ar = statusRank(a.status);
    const br = statusRank(b.status);
    if (ar !== br) return ar - br;

    const ad = a.due_date || "9999-12-31";
    const bd = b.due_date || "9999-12-31";
    if (ad !== bd) return ad.localeCompare(bd);

    return String(b.created_at).localeCompare(String(a.created_at));
  }

  function resultCard(task) {
    return `
      <article class="search-result-row" data-open-task="${task.task_id}">
        <span class="list-status status-${String(task.status).toLowerCase()}">${statusLabel(task.status)}</span>
        <div class="search-result-main">
          <strong>${taskTitleLine(task)}</strong>
          <div>${escapeHtml(task.assigned_name || "-")} · 요청 ${formatDateTime(task.created_at)}${task.due_date ? ` · ${formatDate(task.due_date)}까지` : ""}</div>
        </div>
        <div class="search-result-tags">${(task.tags || []).slice(0, 5).map(t => `<span>${escapeHtml(t)}</span>`).join("")}</div>
      </article>
    `;
  }

  function renderSearchView() {
    const tags = allTags();

    $("taskTagCloud").innerHTML = tags.map(([tag, count]) => `
      <button type="button" class="task-tag-btn ${searchState.tags.has(tag) ? "active" : ""}" data-tag="${escapeHtml(tag)}">
        ${escapeHtml(tag)} <small>${count}</small>
      </button>
    `).join("");

    $("taskSearchActiveTags").innerHTML = searchState.tags.size
      ? [...searchState.tags].map(tag =>
          `<button type="button" data-remove-tag="${escapeHtml(tag)}">${escapeHtml(tag)} ×</button>`
        ).join("")
      : "";

    const rows = tasks
      .filter(searchMatches)
      .sort(searchPrioritySort);

    $("taskSearchResults").innerHTML = rows.length
      ? rows.map(resultCard).join("")
      : '<div class="task-board-empty">검색 결과가 없습니다.</div>';

    $$(".task-tag-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const tag = btn.dataset.tag;
        if (searchState.tags.has(tag)) searchState.tags.delete(tag);
        else searchState.tags.add(tag);
        renderSearchView();
      });
    });

    $$("[data-remove-tag]").forEach(btn => {
      btn.addEventListener("click", () => {
        searchState.tags.delete(btn.dataset.removeTag);
        renderSearchView();
      });
    });

    bindOpenTaskRows();
    $("taskVisibleSummary").textContent = `검색 결과 ${rows.length}건`;
  }

  function renderArchiveView() {
    const rows = tasks
      .filter(t => t.status === "APPROVED")
      .sort((a, b) =>
        String(b.approved_at || "").localeCompare(String(a.approved_at || ""))
      );

    $("taskArchiveList").innerHTML = rows.length
      ? rows.map(task => `
          <article class="archive-row" data-open-task="${task.task_id}">
            <div>
              <span>${escapeHtml(task.category || "기타")}</span>
              <strong>${escapeHtml(task.title || "업무")}</strong>
            </div>
            <div>${escapeHtml(task.assigned_name || "-")}</div>
            <div>${task.due_date ? `${formatDate(task.due_date)} 요청` : "-"}</div>
            <div>승인 ${formatDateTime(task.approved_at)}</div>
          </article>
        `).join("")
      : '<div class="task-board-empty">승인 완료된 업무가 없습니다.</div>';

    bindOpenTaskRows();
    $("taskVisibleSummary").textContent = `완료목록 ${rows.length}건`;
  }

  function renderTaskView() {
    renderEntryPanel();

    $("taskAllView").classList.toggle("hidden", selectedPage !== "ALL");
    $("taskPersonView").classList.toggle("hidden", !selectedMemberTaskPage());
    $("taskSearchView").classList.toggle("hidden", selectedPage !== "SEARCH");
    $("taskArchiveView").classList.toggle("hidden", selectedPage !== "ARCHIVE");

    if (selectedPage === "ALL") renderAllView();
    else if (selectedMemberTaskPage()) renderPersonView();
    else if (selectedPage === "SEARCH") renderSearchView();
    else if (selectedPage === "ARCHIVE") renderArchiveView();
  }

  async function addTask() {
    if (!taskApiReady) return;

    const member = selectedMemberTaskPage();
    if (!member) {
      $("taskEntryMessage").textContent = "담당자 이름 탭을 먼저 선택하세요.";
      return;
    }

    const raw = $("taskNaturalInput").value.trim();
    if (!raw) {
      $("taskEntryMessage").textContent = "업무 내용을 입력하세요.";
      return;
    }

    const parsed = parseNaturalTask(raw);

    $("taskAddBtn").disabled = true;
    $("taskAddBtn").textContent = "등록 중…";

    try {
      const { error } = await client.rpc("kcem_tasks_create_v2", {
        p_token: token(),
        p_category: parsed.category,
        p_title: parsed.title,
        p_raw_text: parsed.rawText,
        p_description: null,
        p_color: parsed.color || null,
        p_tags: parsed.tags,
        p_quantity: parsed.quantity,
        p_quantity_condition: parsed.quantityCondition,
        p_due_date: parsed.dueDate || null,
        p_assigned_to: member.member_id
      });

      if (error) throw error;

      $("taskNaturalInput").value = "";
      $("taskParsePreview").classList.add("hidden");
      $("taskParsePreview").innerHTML = "";
      $("taskEntryMessage").textContent = "";
      await loadTasks();
      $("taskNaturalInput").focus();
    } catch (error) {
      $("taskEntryMessage").textContent = rpcErrorText(error);
    } finally {
      $("taskAddBtn").disabled = false;
      $("taskAddBtn").textContent = "요청 등록";
    }
  }

  function bindKanban() {
    $$(".kanban-card[draggable='true']").forEach(card => {
      card.addEventListener("dragstart", event => {
        draggedTaskId = card.dataset.taskId;
        card.classList.add("dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", draggedTaskId);
      });

      card.addEventListener("dragend", () => {
        draggedTaskId = null;
        card.classList.remove("dragging");
        $$(".kanban-list").forEach(list => list.classList.remove("drag-over"));
      });

      card.addEventListener("click", event => {
        if (event.target.closest("[data-approve]")) return;
        openTaskDetail(card.dataset.taskId);
      });
    });

    $$(".kanban-list").forEach(list => {
      list.addEventListener("dragover", event => {
        event.preventDefault();
        list.classList.add("drag-over");
      });

      list.addEventListener("dragleave", () => {
        list.classList.remove("drag-over");
      });

      list.addEventListener("drop", async event => {
        event.preventDefault();
        list.classList.remove("drag-over");

        const taskId = event.dataTransfer.getData("text/plain") || draggedTaskId;
        const targetStatus = list.dataset.dropStatus;
        if (!taskId || !targetStatus) return;

        await moveTask(taskId, targetStatus);
      });
    });

    $$("[data-approve]").forEach(btn => {
      btn.addEventListener("click", async event => {
        event.stopPropagation();
        await approveTask(btn.dataset.approve);
      });
    });
  }

  async function moveTask(taskId, targetStatus) {
    const task = tasks.find(t => t.task_id === taskId);
    if (!task || task.status === targetStatus || task.status === "APPROVED") return;

    const actor = task.assigned_to || activeMembers[0]?.member_id;
    if (!actor) return;

    try {
      const { error } = await client.rpc("kcem_tasks_move_v2", {
        p_token: token(),
        p_task_id: taskId,
        p_status: targetStatus,
        p_actor_member_id: actor
      });

      if (error) throw error;
      await loadTasks();
    } catch (error) {
      alert(rpcErrorText(error));
    }
  }

  async function approveTask(taskId) {
    const task = tasks.find(t => t.task_id === taskId);
    if (!task || task.status !== "DONE") return;

    const actor = task.assigned_to || activeMembers[0]?.member_id;
    if (!actor) return;

    try {
      const { error } = await client.rpc("kcem_tasks_approve_v2", {
        p_token: token(),
        p_task_id: taskId,
        p_actor_member_id: actor
      });

      if (error) throw error;
      await loadTasks();
    } catch (error) {
      alert(rpcErrorText(error));
    }
  }

  function bindOpenTaskRows() {
    $$("[data-open-task]").forEach(row => {
      row.addEventListener("click", () => openTaskDetail(row.dataset.openTask));
    });
  }

  function setQtyCondition(value) {
    editQtyCondition = value || "EXACT";
    $$("[data-qty-condition]").forEach(btn =>
      btn.classList.toggle("active", btn.dataset.qtyCondition === editQtyCondition)
    );
  }

  function setEditAssignee(memberId) {
    editAssigneeId = memberId;
    $$("[data-edit-assignee]").forEach(btn =>
      btn.classList.toggle("active", btn.dataset.editAssignee === editAssigneeId)
    );
  }

  function openTaskDetail(taskId) {
    const task = tasks.find(t => t.task_id === taskId);
    if (!task) return;

    $("taskEditId").value = task.task_id;
    $("taskEditCategory").value = task.category || "";
    $("taskEditColor").value = task.color || "";
    $("taskEditTitle").value = task.title || "";
    $("taskEditQuantity").value = task.quantity || "";
    $("taskEditDueDate").value = dateOnly(task.due_date);
    $("taskEditTags").value = (task.tags || []).join(", ");
    $("taskEditDescription").value = task.description || "";

    $("taskEditAssigneeButtons").innerHTML = activeMembers.map(member =>
      `<button type="button" data-edit-assignee="${member.member_id}">${escapeHtml(member.member_name)}</button>`
    ).join("");

    setEditAssignee(task.assigned_to);
    setQtyCondition(task.quantity_condition || "EXACT");

    $("taskDetailHeading").textContent = `${task.category || "기타"} ${task.title || "업무"}`;
    $("taskDetailStatus").textContent = statusLabel(task.status);
    $("taskDetailStatus").className = `task-detail-status status-${String(task.status).toLowerCase()}`;

    const dates = [
      `요청 ${formatDateTime(task.created_at)}`,
      task.started_at ? `시작 ${formatDateTime(task.started_at)}` : "",
      task.completed_at ? `완료 ${formatDateTime(task.completed_at)}` : "",
      task.approved_at ? `승인 ${formatDateTime(task.approved_at)}` : ""
    ].filter(Boolean).join(" · ");

    $("taskDetailDates").textContent = dates;

    const hasRaw = Boolean(task.raw_text);
    $("taskOriginalTextWrap").classList.toggle("hidden", !hasRaw);
    $("taskOriginalText").textContent = task.raw_text || "";

    $("taskApproveBtn").classList.toggle("hidden", task.status !== "DONE");
    $("taskReopenBtn").classList.toggle(
      "hidden",
      !["IN_PROGRESS", "DONE", "APPROVED"].includes(task.status)
    );

    $("taskEditMessage").textContent = "";
    $("taskEditOverlay").classList.remove("hidden");

    $$("[data-edit-assignee]").forEach(btn => {
      btn.addEventListener("click", () => setEditAssignee(btn.dataset.editAssignee));
    });
  }

  function closeTaskDetail() {
    $("taskEditOverlay").classList.add("hidden");
  }

  async function saveTaskDetail() {
    const id = $("taskEditId").value;
    const task = tasks.find(t => t.task_id === id);
    if (!task) return;

    const category = $("taskEditCategory").value.trim() || "기타";
    const title = $("taskEditTitle").value.trim();
    const color = $("taskEditColor").value.trim();
    const quantityText = $("taskEditQuantity").value.trim();
    const quantity = quantityText ? Number(quantityText) : null;
    const dueDate = $("taskEditDueDate").value || null;
    const tags = $("taskEditTags").value
      .split(",")
      .map(x => x.trim())
      .filter(Boolean);

    if (!title) {
      $("taskEditMessage").textContent = "업무 이름을 입력하세요.";
      return;
    }

    if (quantity !== null && (!Number.isInteger(quantity) || quantity < 1)) {
      $("taskEditMessage").textContent = "수량을 확인하세요.";
      return;
    }

    if (!editAssigneeId) {
      $("taskEditMessage").textContent = "담당자를 선택하세요.";
      return;
    }

    try {
      $("taskEditSaveBtn").disabled = true;

      const { error } = await client.rpc("kcem_tasks_update_v2", {
        p_token: token(),
        p_task_id: id,
        p_category: category,
        p_title: title,
        p_description: $("taskEditDescription").value.trim() || null,
        p_color: color || null,
        p_tags: tags,
        p_quantity: quantity,
        p_quantity_condition: editQtyCondition,
        p_due_date: dueDate,
        p_assigned_to: editAssigneeId,
        p_actor_member_id: editAssigneeId
      });

      if (error) throw error;

      closeTaskDetail();
      await loadTasks();
    } catch (error) {
      $("taskEditMessage").textContent = rpcErrorText(error);
    } finally {
      $("taskEditSaveBtn").disabled = false;
    }
  }

  async function deleteTask() {
    const id = $("taskEditId").value;
    const task = tasks.find(t => t.task_id === id);
    if (!task) return;

    if (!confirm(`'${task.category} ${task.title}' 업무를 삭제할까요?`)) return;

    try {
      const { error } = await client.rpc("kcem_tasks_delete", {
        p_token: token(),
        p_task_id: id,
        p_actor_member_id: task.assigned_to
      });

      if (error) throw error;
      closeTaskDetail();
      await loadTasks();
    } catch (error) {
      $("taskEditMessage").textContent = rpcErrorText(error);
    }
  }

  async function reopenCurrentTask() {
    const id = $("taskEditId").value;
    const task = tasks.find(t => t.task_id === id);
    if (!task) return;

    closeTaskDetail();
    await moveTask(id, "REQUESTED");
  }

  async function approveCurrentTask() {
    const id = $("taskEditId").value;
    closeTaskDetail();
    await approveTask(id);
  }

  function renderMemberManage() {
    $("memberManageList").innerHTML = allMembers.map(m => `
      <div class="member-manage-row ${m.is_active ? "" : "inactive"}">
        <div>
          <strong>${escapeHtml(m.member_name)}</strong>
          <span>${m.is_active ? "사용중" : "비활성"}</span>
        </div>
        <div class="member-manage-actions">
          <button type="button" class="task-mini-btn" data-rename="${m.member_id}">이름수정</button>
          <button type="button" class="task-mini-btn ${m.is_active ? "danger-lite" : ""}"
                  data-active="${m.member_id}" data-value="${m.is_active ? "false" : "true"}">
            ${m.is_active ? "삭제" : "복원"}
          </button>
        </div>
      </div>
    `).join("");

    $$("[data-rename]").forEach(btn =>
      btn.addEventListener("click", () => renameMember(btn.dataset.rename))
    );

    $$("[data-active]").forEach(btn =>
      btn.addEventListener("click", () =>
        setMemberActive(btn.dataset.active, btn.dataset.value === "true")
      )
    );
  }

  async function addMember() {
    const name = $("newMemberName").value.trim();
    if (!name) return;

    try {
      const { error } = await client.rpc("kcem_tasks_member_create", {
        p_token: token(),
        p_name: name
      });
      if (error) throw error;
      $("newMemberName").value = "";
      await loadMembers();
      renderTaskView();
    } catch (error) {
      $("memberMessage").textContent = rpcErrorText(error);
    }
  }

  async function renameMember(id) {
    const member = allMembers.find(m => m.member_id === id);
    if (!member) return;

    const name = prompt("새 팀원 이름", member.member_name);
    if (name === null || !name.trim()) return;

    try {
      const { error } = await client.rpc("kcem_tasks_member_rename", {
        p_token: token(),
        p_member_id: id,
        p_name: name.trim()
      });
      if (error) throw error;
      await loadMembers();
      await loadTasks();
    } catch (error) {
      $("memberMessage").textContent = rpcErrorText(error);
    }
  }

  async function setMemberActive(id, active) {
    const member = allMembers.find(m => m.member_id === id);
    if (!member) return;

    if (
      !active &&
      !confirm(`${member.member_name} 팀원을 삭제(비활성)할까요?\n과거 업무 기록은 유지됩니다.`)
    ) return;

    try {
      const { error } = await client.rpc("kcem_tasks_member_set_active", {
        p_token: token(),
        p_member_id: id,
        p_is_active: active
      });
      if (error) throw error;
      await loadMembers();
      await loadTasks();
    } catch (error) {
      $("memberMessage").textContent = rpcErrorText(error);
    }
  }

  function bindSortHeaders() {
    $$(".task-sort-head").forEach(btn => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.sort;
        if (allSort.key === key) {
          allSort.dir = allSort.dir === "asc" ? "desc" : "asc";
        } else {
          allSort.key = key;
          allSort.dir = key === "created" ? "desc" : "asc";
        }
        renderAllView();
      });
    });
  }

  function bind() {
    $$(".module-tab").forEach(btn =>
      btn.addEventListener("click", () => setModule(btn.dataset.module))
    );

    $("taskNaturalInput").addEventListener("input", previewNaturalInput);
    $("taskNaturalInput").addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        addTask();
      }
    });

    $("taskAddBtn").addEventListener("click", addTask);
    $("taskRefreshBtn").addEventListener("click", loadAll);

    $("taskSearchInput").addEventListener("input", event => {
      searchState.text = event.target.value;
      renderSearchView();
    });

    $("memberManageBtn").addEventListener("click", () => {
      renderMemberManage();
      $("memberOverlay").classList.remove("hidden");
    });
    $("memberCloseBtn").addEventListener("click", () =>
      $("memberOverlay").classList.add("hidden")
    );
    $("memberAddBtn").addEventListener("click", addMember);
    $("newMemberName").addEventListener("keydown", event => {
      if (event.key === "Enter") addMember();
    });

    $("taskEditCloseBtn").addEventListener("click", closeTaskDetail);
    $("taskEditCancelBtn").addEventListener("click", closeTaskDetail);
    $("taskEditForm").addEventListener("submit", event => {
      event.preventDefault();
      saveTaskDetail();
    });
    $("taskDeleteBtn").addEventListener("click", deleteTask);
    $("taskReopenBtn").addEventListener("click", reopenCurrentTask);
    $("taskApproveBtn").addEventListener("click", approveCurrentTask);

    $$("[data-qty-condition]").forEach(btn => {
      btn.addEventListener("click", () => setQtyCondition(btn.dataset.qtyCondition));
    });

    bindSortHeaders();
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => {
      if (!document.hidden && !$("taskApp").classList.contains("hidden")) {
        loadAll();
      }
    }, Math.max(5000, Number(cfg.POLL_INTERVAL_MS || 5000)));
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function start() {
    if (
      !cfg.SUPABASE_URL ||
      !cfg.SUPABASE_PUBLISHABLE_KEY ||
      !window.supabase
    ) return;

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

    bind();
    renderPrimaryTabs();
    setModule("sales");
  }

  start();
})();
