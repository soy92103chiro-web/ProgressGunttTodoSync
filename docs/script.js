
        import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js';
        import { 
            getAuth, 
            signInWithEmailAndPassword, 
            createUserWithEmailAndPassword,
            GoogleAuthProvider,
            signInWithPopup,
            onAuthStateChanged,
            signOut
        } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js';
        import { getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';
        import { firebaseConfig } from './firebase-config.js';
        
        const app = initializeApp(firebaseConfig);
        const auth = getAuth(app);
        const db = getFirestore(app);
        const appId = 'progress-gantt-sync';

        let currentUser = null;
        let firestoreUnsubscribes = [];

        let state = {
            projects: [],
            tasks: [],
            taskTemplates: [],
            projectTemplates: [],
            currentView: 'kanban',
            expandedGanttTasks: new Set(),
            selectedTasks: new Set(),
            ganttSelectedProjects: new Set(),
            kanbanSelectedProjects: new Set(),
            projectSearchTerm: '',
            showCompletedProjects: false,
            weeklyBaseDate: null,
            companyHolidays: [],
            adHocTemplates: [
                { id: 'free', name: '自由入力', duration: 2, isFree: true, icon: 'fa-pen-to-square' },
                { id: 'mtg', name: '会議', duration: 2, isFree: false, icon: 'fa-handshake' }
            ]
        };

        function isProjectCompleted(projectId) {
            if (!projectId) return false;
            const p = state.projects.find(x => x.id === projectId);
            return p ? p.status === 'completed' : false;
        }

        function getProjectDueDate(project) {
            let max = new Date('1970-01-01').getTime();
            let found = false;
            
            // From tasks
            state.tasks.filter(t => t.projectId === project.id).forEach(t => {
                if (t.dueDate) {
                    const d = new Date(t.dueDate).getTime();
                    if (d > max) max = d;
                    found = true;
                }
            });
            
            // From milestones
            if (project.milestones) {
                project.milestones.forEach(ms => {
                    if (ms.type === 'point' && ms.date) {
                        const d = new Date(ms.date).getTime();
                        if (d > max) max = d;
                        found = true;
                    } else if (ms.type === 'range' && ms.endDate) {
                        const d = new Date(ms.endDate).getTime();
                        if (d > max) max = d;
                        found = true;
                    }
                });
            }
            
            return found ? max : new Date('2099-12-31').getTime();
        }

        function toggleShowCompletedProjects(checked) {
            state.showCompletedProjects = !!checked;
            
            // Sync all checkboxes in the DOM
            document.querySelectorAll('.show-completed-toggle').forEach(el => {
                el.checked = state.showCompletedProjects;
            });
            
            refreshCurrentView();
            renderProjectCards();
        }

        function renderAdHocTemplates() {
            const container = document.getElementById('weekly-adhoc-pool');
            if (!container) return;
            container.innerHTML = state.adHocTemplates.map(tmpl => `
                <div class="p-2.5 bg-white border-2 border-slate-100 rounded-xl shadow-sm text-xs font-bold cursor-grab active:cursor-grabbing hover:border-cyan-400 transition-all text-slate-700 flex items-center gap-2"
                     draggable="true" ondragstart="dragStartWeeklyAdhoc(event, '${tmpl.name}', ${tmpl.duration}, ${tmpl.isFree})">
                    <i class="fa-solid ${tmpl.icon} text-cyan-500"></i>
                    <span>${tmpl.name}</span>
                    <span class="text-[10px] text-slate-400">(${tmpl.duration*0.5}h)</span>
                </div>
            `).join('');
        }

        let projectSelectMode = 'gantt'; // 'gantt' or 'kanban'

        function openProjectSelectModal(mode = 'gantt') {
            projectSelectMode = mode;
            state.projectSearchTerm = '';
            document.getElementById('project-search-input').value = '';
            renderProjectCards();
            showModal('project-select-modal');
        }

        function renderProjectCards() {
            const term = document.getElementById('project-search-input').value.toLowerCase();
            const container = document.getElementById('project-card-container');

            let filtered = state.projects.filter(p => p.name.toLowerCase().includes(term));
            const selectedSet = projectSelectMode === 'gantt' ? state.ganttSelectedProjects : state.kanbanSelectedProjects;

            if (!state.showCompletedProjects) {
                filtered = filtered.filter(p => !isProjectCompleted(p.id));
            }

            filtered.sort((a, b) => {
                const compA = isProjectCompleted(a.id);
                const compB = isProjectCompleted(b.id);
                if (compA !== compB) return compA ? 1 : -1;
                return getProjectDueDate(a) - getProjectDueDate(b);
            });

            if (filtered.length === 0) {
                container.innerHTML = `<div class="col-span-full py-12 text-center text-slate-600 font-mono text-xs uppercase tracking-widest italic">登録されている案件はありません</div>`;
                return;
            }

            container.className = "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4";
            container.innerHTML = filtered.map(p => {
                const isSelected = selectedSet.has(p.id);
                const taskCount = state.tasks.filter(t => t.projectId === p.id).length;
                const isCompleted = isProjectCompleted(p.id);
                const borderClass = isSelected ? 'border-cyan-500/50 bg-cyan-500/5 shadow-[0_0_15px_rgba(0,243,255,0.1)]' : 'border-slate-800 bg-slate-900/60 hover:border-slate-700';

                return `
                    <div onclick="toggleProjectSelection('${p.id}')"
                          class="cursor-pointer border-2 rounded-xl p-4 transition-all font-mono ${borderClass} ${isCompleted ? 'opacity-40 grayscale-[0.8]' : ''}">
                        <div class="flex justify-between items-start mb-3">
                            <div class="w-3 h-3 rounded-full shadow-[0_0_8px_${p.color}]" style="background-color: ${p.color}"></div>
                            <div class="flex items-center gap-2">
                                ${isCompleted ? '<span class="text-[9px] bg-slate-950 text-slate-500 px-2 py-0.5 rounded font-black border border-slate-800 uppercase tracking-tighter">アーカイブ済</span>' : ''}
                                ${isSelected ? '<i class="fa-solid fa-circle-check neon-text-blue text-xl"></i>' : '<div class="w-5 h-5 rounded-full border-2 border-slate-700 bg-slate-950"></div>'}
                            </div>
                        </div>
                        <h3 class="font-black ${isSelected ? 'neon-text-blue' : 'text-slate-300'} text-xs mb-3 line-clamp-2 min-h-[2.5rem] uppercase tracking-tight">${p.name}${isCompleted ? ' [完了]' : ''}</h3>
                        <div class="flex items-center text-[10px] text-slate-500 gap-3 uppercase tracking-widest">
                            <span><i class="fa-solid fa-microchip mr-1 text-cyan-600"></i>${taskCount} ユニット</span>
                        </div>
                    </div>
                `;
            }).join('');
        }

        function toggleProjectSelection(id) {
            const selectedSet = projectSelectMode === 'gantt' ? state.ganttSelectedProjects : state.kanbanSelectedProjects;
            if (selectedSet.has(id)) selectedSet.delete(id);
            else selectedSet.add(id);
            renderProjectCards();
            
            // Live update views
            if (projectSelectMode === 'gantt') {
                const countEl = document.getElementById('gantt-selected-count');
                if (countEl) countEl.innerText = state.ganttSelectedProjects.size === 0 ? '全' : state.ganttSelectedProjects.size;
                renderGantt();
            } else {
                const countEl = document.getElementById('kanban-selected-count');
                if (countEl) countEl.innerText = state.kanbanSelectedProjects.size === 0 ? '全' : state.kanbanSelectedProjects.size;
                renderKanban();
            }
        }

        function selectAllProjects(select) {
            const selectedSet = projectSelectMode === 'gantt' ? state.ganttSelectedProjects : state.kanbanSelectedProjects;
            if (select) {
                // Only select projects that are currently visible/filtered
                const term = document.getElementById('project-search-input').value.toLowerCase();
                let filtered = state.projects.filter(p => p.name.toLowerCase().includes(term));
                if (!state.showCompletedProjects) {
                    filtered = filtered.filter(p => !isProjectCompleted(p.id));
                }
                filtered.forEach(p => selectedSet.add(p.id));
            } else {
                selectedSet.clear();
            }
            renderProjectCards();
            
            // Live update views
            if (projectSelectMode === 'gantt') {
                const countEl = document.getElementById('gantt-selected-count');
                if (countEl) countEl.innerText = state.ganttSelectedProjects.size === 0 ? '全' : state.ganttSelectedProjects.size;
                renderGantt();
            } else {
                const countEl = document.getElementById('kanban-selected-count');
                if (countEl) countEl.innerText = state.kanbanSelectedProjects.size === 0 ? '全' : state.kanbanSelectedProjects.size;
                renderKanban();
            }
        }

        function applyProjectSelection() {
            // Already updated live, so just close the modal
            closeModal('project-select-modal');
        }

        function addCustomAdHocTemplate() {
            const name = prompt("テンプレート名を入力してください", "来客対応");
            if (!name) return;
            const hoursStr = prompt("所要時間を入力してください (1=0.5h, 2=1h, 4=2h...)", "2");
            if (!hoursStr || isNaN(hoursStr)) return;

            state.adHocTemplates.push({
                id: generateId(),
                name: name,
                duration: parseInt(hoursStr),
                isFree: false,
                icon: 'fa-star'
            });
            renderAdHocTemplates();
        }

        let workingTask = null;
        let editingProjectId = null;
        let editingMilestones = [];
        let editingTemplate = null;

        const generateId = () => Math.random().toString(36).substr(2, 9);

        const saveDoc = async (colName, docId, data) => {
            if (!currentUser) return;
            try {
                await setDoc(doc(db, 'artifacts', appId, 'users', currentUser.uid, colName, docId), data);
            } catch (e) {
                console.error("Save error:", e);
                showDialog('エラー', 'データの保存に失敗しました。', 'error');
            }
        };

        const deleteDocById = async (colName, docId) => {
            if (!currentUser) return;
            try {
                await deleteDoc(doc(db, 'artifacts', appId, 'users', currentUser.uid, colName, docId));
            } catch (e) {
                console.error("Delete error:", e);
            }
        };

        function refreshCurrentView() {
            // If showCompletedProjects is false, ensure currently selected projects are still valid
            if (!state.showCompletedProjects) {
                const kanbanSelect = document.getElementById('kanban-project-filter');
                if (kanbanSelect && isProjectCompleted(kanbanSelect.value)) kanbanSelect.value = 'all';
                
                const weeklySelect = document.getElementById('weekly-project-filter');
                if (weeklySelect && isProjectCompleted(weeklySelect.value)) weeklySelect.value = 'all';
                
                // Also clean up multi-select sets
                for (const id of Array.from(state.kanbanSelectedProjects)) {
                    if (isProjectCompleted(id)) state.kanbanSelectedProjects.delete(id);
                }
                for (const id of Array.from(state.ganttSelectedProjects)) {
                    if (isProjectCompleted(id)) state.ganttSelectedProjects.delete(id);
                }
            }

            updateProjectFilters();
            updateProjectTemplatesDropdown();
            updateTaskTemplatesDropdown();
            
            if (state.currentView === 'kanban') renderKanban(); 
            else if (state.currentView === 'gantt') renderGantt();
            else if (state.currentView === 'weekly') renderWeekly();
        }

        const defaultMilestonesTemplate = [
            { id: 'm1', name: '設計着手', type: 'point', icon: 'fa-pen-ruler', color: '#2563eb', date: '', startDate: '', endDate: '' },
            { id: 'm2', name: '出図期日', type: 'point', icon: 'fa-file-export', color: '#4f46e5', date: '', startDate: '', endDate: '' },
            { id: 'm3', name: '製作期間', type: 'range', icon: 'fa-wrench', color: '#ea580c', date: '', startDate: '', endDate: '' },
            { id: 'm4', name: '試験期間', type: 'range', icon: 'fa-vial', color: '#9333ea', date: '', startDate: '', endDate: '' },
            { id: 'm5', name: '客先立会', type: 'point', icon: 'fa-handshake', color: '#eab308', date: '', startDate: '', endDate: '' },
            { id: 'm6', name: '出荷日', type: 'point', icon: 'fa-truck-fast', color: '#16a34a', date: '', startDate: '', endDate: '' }
        ];

        const initialSeedData = {
            projects: [
                { 
                    id: 'p1', name: 'デモ設備導入案件', color: '#3b82f6',
                    milestones: [
                        { id: 'm1', name: '設計着手', type: 'point', icon: 'fa-pen-ruler', color: '#3b82f6', date: '2026-06-02' },
                        { id: 'm2', name: '出図期日', type: 'point', icon: 'fa-file-export', color: '#4f46e5', date: '2026-06-15' },
                        { id: 'm3', name: '製作期間', type: 'range', icon: 'fa-wrench', color: '#ea580c', startDate: '2026-06-16', endDate: '2026-06-30' },
                        { id: 'm4', name: '試験期間', type: 'range', icon: 'fa-vial', color: '#9333ea', startDate: '2026-07-01', endDate: '2026-07-05' },
                        { id: 'm5', name: '客先立会', type: 'point', icon: 'fa-handshake', color: '#eab308', date: '2026-07-03' },
                        { id: 'm6', name: '出荷日', type: 'point', icon: 'fa-truck-fast', color: '#16a34a', date: '2026-07-10' }
                    ]
                },
                { id: 'p2', name: 'システム要件定義', color: '#10b981', milestones: [] }
            ],
            tasks: [
                {
                    id: 't1', projectId: 'p1', title: '基本設計', status: 'todo',
                    dueDate: '2026-06-10', startDate: '2026-06-08', totalHours: 12, notes: '',
                    subtasks: [ 
                        { id: 's1', title: '仕様確認', hours: 6, progress: 0, completed: false, assignments: [], notes: '' }, 
                        { id: 's2', title: '構想図作成', hours: 6, progress: 0, completed: false, assignments: [], notes: '' } 
                    ]
                },
                {
                    id: 't2', projectId: 'p2', title: 'ヒアリング', status: 'in_progress',
                    dueDate: '2026-05-20', startDate: '2026-05-15', totalHours: 8, notes: '※納期遅延のテスト用データ',
                    subtasks: [ 
                        { id: 's3', title: 'A社ヒアリング', hours: 4, progress: 100, completed: false, 
                          assignments: [{ id: 'a1', date: '2026-06-01', startSlot: 0, duration: 4 }, { id: 'a2', date: '2026-06-02', startSlot: 2, duration: 4 }], notes: '' }, 
                        { id: 's4', title: '議事録作成', hours: 4, progress: 0, completed: false, assignments: [], notes: '' } 
                    ]
                }
            ],
            taskTemplates: [
                { id: 'tt1', title: '【標準】設計業務', totalHours: 18, subtasks: [ { title: '基本設計', hours: 6, notes: '' }, { title: '詳細設計', hours: 12, notes: '' } ]}
            ],
            projectTemplates: []
        };

        async function loginWithEmail() {
            const email = document.getElementById('email-input').value;
            const pass = document.getElementById('password-input').value;
            if(!email || !pass) { alert("メールアドレスとパスワードを入力してください"); return; }
            try {
                await signInWithEmailAndPassword(auth, email, pass);
            } catch (error) {
                alert("ログイン失敗: " + error.message);
            }
        }

        async function registerWithEmail() {
            const email = document.getElementById('email-input').value;
            const pass = document.getElementById('password-input').value;
            if(!email || !pass) { alert("メールアドレスとパスワードを入力してください"); return; }
            try {
                await createUserWithEmailAndPassword(auth, email, pass);
            } catch (error) {
                alert("登録失敗: " + error.message);
            }
        }

        async function loginWithGoogle() {
            const provider = new GoogleAuthProvider();
            try {
                await signInWithPopup(auth, provider);
            } catch (error) {
                alert("Googleログイン失敗: " + error.message);
            }
        }

        async function logoutUser() {
            try {
                await signOut(auth);
            } catch (error) {
                console.error("Logout Error:", error);
            }
        }

        function setupFirestoreListeners() {
            if (!currentUser) return;
            firestoreUnsubscribes.forEach(u => u());
            firestoreUnsubscribes = [];

            const getColRef = (colName) => collection(db, 'artifacts', appId, 'users', currentUser.uid, colName);

            // 各コレクションが空の場合に個別にシードデータを投入するように修正
            firestoreUnsubscribes.push(onSnapshot(getColRef('projects'), async (snapshot) => {
                if (snapshot.empty) {
                    for (let p of initialSeedData.projects) await saveDoc('projects', p.id, p);
                } else {
                    state.projects = snapshot.docs.map(doc => doc.data());
                    refreshCurrentView();
                }
            }, (error) => console.error("Projects Error:", error)));

            firestoreUnsubscribes.push(onSnapshot(getColRef('tasks'), async (snapshot) => {
                if (snapshot.empty) {
                    for (let t of initialSeedData.tasks) await saveDoc('tasks', t.id, t);
                } else {
                    state.tasks = snapshot.docs.map(doc => doc.data());
                    refreshCurrentView();
                }
            }, (error) => console.error("Tasks Error:", error)));

            firestoreUnsubscribes.push(onSnapshot(getColRef('projectTemplates'), async (snapshot) => {
                if (snapshot.empty) {
                    for (let pt of initialSeedData.projectTemplates) await saveDoc('projectTemplates', pt.id, pt);
                } else {
                    state.projectTemplates = snapshot.docs.map(doc => doc.data());
                    updateProjectTemplatesDropdown();
                }
            }, (error) => console.error("Project Templates Error:", error)));

            firestoreUnsubscribes.push(onSnapshot(getColRef('taskTemplates'), async (snapshot) => {
                if (snapshot.empty) {
                    for (let tt of initialSeedData.taskTemplates) await saveDoc('taskTemplates', tt.id, tt);
                } else {
                    state.taskTemplates = snapshot.docs.map(doc => doc.data());
                    updateTaskTemplatesDropdown();
                }
            }, (error) => console.error("Task Templates Error:", error)));

            firestoreUnsubscribes.push(onSnapshot(getColRef('config'), async (snapshot) => {
                const holidaysDoc = snapshot.docs.find(d => d.id === 'holidays');
                if (holidaysDoc) {
                    state.companyHolidays = holidaysDoc.data().dates || [];
                    if(state.currentView === 'kanban') renderKanban();
                    if(state.currentView === 'gantt') renderGantt();
                    if(state.currentView === 'weekly') renderWeekly();
                }
            }));
        }

        const holidays = new Set([
            '2026-01-01', '2026-01-12', '2026-02-11', '2026-02-23', '2026-03-20',
            '2026-04-29', '2026-05-03', '2026-05-04', '2026-05-05', '2026-05-06',
            '2026-07-20', '2026-08-11', '2026-09-21', '2026-09-22', '2026-09-23',
            '2026-10-12', '2026-11-03', '2026-11-23'
        ]);

        function isBusinessDay(dateInput) {
            const d = new Date(dateInput);
            const day = d.getDay();
            if (day === 0 || day === 6) return false;
            const yyyymmdd = dateUtils.formatDate(d);
            return !holidays.has(yyyymmdd) && !state.companyHolidays.includes(yyyymmdd);
        }

        function openCalendarModal() {
            renderCompanyHolidays();
            showModal('calendar-modal');
        }

        function renderCompanyHolidays() {
            const container = document.getElementById('company-holidays-list');
            if (!container) return;
            
            if (state.companyHolidays.length === 0) {
                container.innerHTML = '<p class="text-xs text-slate-600 italic py-8 text-center font-mono uppercase tracking-widest">設定された休業日はありません</p>';
                return;
            }

            const sortedHolidays = [...state.companyHolidays].sort();
            container.innerHTML = sortedHolidays.map(h => `
                <div class="flex items-center justify-between p-3 bg-slate-950/40 border border-slate-800 rounded-lg shadow-sm font-mono">
                    <span class="text-xs font-bold text-slate-300 uppercase tracking-tighter">${h.replace(/-/g, '.')}</span>
                    <button onclick="removeCompanyHoliday('${h}')" class="text-fuchsia-500/70 hover:text-fuchsia-400 px-2 transition-all">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>
            `).join('');
        }

        async function recalculateAllTaskDates() {
            for (const task of state.tasks) {
                if (task.status !== 'done' && task.dueDate) {
                    const newStartDate = calculateStartDate(task.dueDate, task.totalHours, task.id);
                    if (newStartDate !== task.startDate) {
                        task.startDate = newStartDate;
                        await saveDoc('tasks', task.id, task);
                    }
                }
            }
        }

        async function addCompanyHoliday() {
            const input = document.getElementById('new-holiday-input');
            const date = input.value;
            if (!date) return;
            
            if (state.companyHolidays.includes(date)) {
                showDialog('案内', 'その日付は既に休業日として設定されています。', 'warning');
                return;
            }

            state.companyHolidays.push(date);
            input.value = '';
            
            await saveDoc('config', 'holidays', { dates: state.companyHolidays });
            await recalculateAllTaskDates();
            renderCompanyHolidays();
            refreshCurrentView();
        }

        async function removeCompanyHoliday(date) {
            state.companyHolidays = state.companyHolidays.filter(h => h !== date);
            await saveDoc('config', 'holidays', { dates: state.companyHolidays });
            await recalculateAllTaskDates();
            renderCompanyHolidays();
            refreshCurrentView();
        }

        function handlePrint() {
            document.body.classList.add('print-weekly');
            const rangeText = document.getElementById('weekly-current-date-range').innerText;
            document.getElementById('print-date-range').innerText = rangeText;
            document.getElementById('print-current-date-weekly').innerText = new Date().toLocaleDateString('ja-JP');
            setTimeout(() => {
                window.print();
                document.body.classList.remove('print-weekly');
            }, 50);
        }

        async function handleGanttPrint() {
            document.body.classList.add('print-gantt');
            const printArea = document.getElementById('gantt-print-area');
            printArea.innerHTML = '';
            
            let filteredProjects = state.projects;
            
            if (!state.showCompletedProjects) {
                filteredProjects = filteredProjects.filter(p => !isProjectCompleted(p.id));
            }

            if (state.ganttSelectedProjects.size > 0) {
                filteredProjects = filteredProjects.filter(p => state.ganttSelectedProjects.has(p.id));
            }

            if (filteredProjects.length === 0) {
                showDialog('案内', '印刷する案件を選択してください。', 'warning');
                document.body.classList.remove('print-gantt');
                return;
            }

            // A3横印刷用の設定
            const cellWidth = 24; // 視認性を確保するための固定幅
            const headerWidth = 250; // 左側タスク名の幅
            const availableWidth = 1400; // A3横の有効コンテンツ幅（px目安）
            const daysPerRow = Math.floor((availableWidth - headerWidth) / cellWidth);

            for (let i = 0; i < filteredProjects.length; i++) {
                const proj = filteredProjects[i];
                const pageDiv = document.createElement('div');
                pageDiv.className = 'gantt-print-page';
                
                const projTasks = state.tasks.filter(t => t.projectId === proj.id);
                
                // プロジェクトの表示期間を算出
                let min = new Date('2099-12-31'); let max = new Date('1970-01-01');
                let found = false;
                projTasks.forEach(t => {
                    if (t.startDate) { const d = new Date(t.startDate); if (d < min) min = d; found = true; }
                    if (t.dueDate) { const d = new Date(t.dueDate); if (d > max) max = d; found = true; }
                });
                if (proj.milestones) {
                    proj.milestones.forEach(ms => {
                        if(ms.type === 'point' && ms.date) { const d = new Date(ms.date); if(d < min) min = d; if(d > max) max = d; found = true; }
                        else if (ms.type === 'range') {
                            if(ms.startDate) { const d = new Date(ms.startDate); if(d < min) min = d; found = true; }
                            if(ms.endDate) { const d = new Date(ms.endDate); if(d > max) max = d; found = true; }
                        }
                    });
                }

                if (!found) {
                    const today = new Date();
                    min = new Date(today.getFullYear(), today.getMonth(), 1);
                    max = new Date(today.getFullYear(), today.getMonth() + 1, 0);
                } else {
                    min = new Date(min.getFullYear(), min.getMonth(), 1);
                    max = new Date(max.getFullYear(), max.getMonth() + 1, 0);
                }

                const totalH = projTasks.reduce((sum, t) => sum + (t.totalHours || 0), 0) || 1;
                const doneH = projTasks.reduce((sum, t) => {
                    return sum + t.subtasks.reduce((ssum, s) => ssum + (s.hours * ((s.progress||0)/100)), 0);
                }, 0);
                const progressPercent = Math.round((doneH / totalH) * 100);

                const msHtml = (proj.milestones || []).map(ms => {
                    const d = ms.type === 'point' ? ms.date : `${ms.startDate}〜`;
                    return `<div class="flex items-center gap-1 bg-gray-50 px-2 py-0.5 rounded border border-gray-200 text-[10px]">
                                <i class="fa-solid ${ms.icon}" style="color:${ms.color}"></i>
                                <span class="font-bold">${ms.name}:</span>
                                <span class="text-gray-600">${d}</span>
                            </div>`;
                }).join('');

                const projectHeaderHtml = `
                    <div class="mb-4 border-b-4 border-indigo-600 pb-2">
                        <div class="flex justify-between items-start mb-2">
                            <div>
                                <div class="flex items-center gap-3 mb-1">
                                    <div class="w-5 h-5 rounded" style="background-color: ${proj.color}"></div>
                                    <h2 class="text-2xl font-bold text-gray-800">${proj.name}</h2>
                                </div>
                            </div>
                            <div class="text-right">
                                <div class="text-[10px] text-gray-400">出力日: ${new Date().toLocaleDateString('ja-JP')}</div>
                                <div class="text-xl font-black text-indigo-600 mt-1">${progressPercent}% <span class="text-[10px] font-normal text-gray-400">完了</span></div>
                            </div>
                        </div>
                        <div class="w-full bg-gray-100 rounded-full h-2 mb-3 overflow-hidden border border-gray-200">
                            <div class="bg-indigo-600 h-2" style="width: ${progressPercent}%"></div>
                        </div>
                        <div class="flex flex-wrap gap-2">
                            <div class="text-[10px] font-bold text-gray-400 mr-2 self-center uppercase tracking-widest">主要マイルストーン:</div>
                            ${msHtml || '<span class="text-[10px] text-gray-300 italic">設定なし</span>'}
                        </div>
                    </div>
                `;

                // 日付範囲をセグメントに分割して出力
                const totalDays = Math.ceil((max - min) / (1000 * 60 * 60 * 24)) + 1;
                const segments = Math.ceil(totalDays / daysPerRow);
                let segmentsHtml = '';
                
                for (let s = 0; s < segments; s++) {
                    const segStart = new Date(min);
                    segStart.setDate(segStart.getDate() + (s * daysPerRow));
                    let segEnd = new Date(segStart);
                    segEnd.setDate(segEnd.getDate() + daysPerRow - 1);
                    if (segEnd > max) segEnd = new Date(max);

                    segmentsHtml += `
                        <div class="mb-8 border border-gray-200 rounded-lg overflow-hidden shadow-sm">
                            <div class="bg-gray-100 px-4 py-1.5 border-b border-gray-200 text-[11px] font-bold text-gray-600 flex justify-between items-center">
                                <span>表示期間: ${segStart.toLocaleDateString('ja-JP')} 〜 ${segEnd.toLocaleDateString('ja-JP')}</span>
                                <span class="text-gray-400 text-[10px] font-normal">${s + 1} / ${segments} ページ</span>
                            </div>
                            <div class="gantt-segment-wrapper bg-white">
                                ${generateGanttHTML(segStart, segEnd, [proj], projTasks, cellWidth, headerWidth)}
                            </div>
                        </div>
                    `;
                }

                pageDiv.innerHTML = `
                    <div class="project-print-block">
                        ${projectHeaderHtml}
                        <div class="gantt-print-segments">
                            ${segmentsHtml}
                        </div>
                    </div>
                `;
                printArea.appendChild(pageDiv);
            }

            setTimeout(() => {
                window.print();
                document.body.classList.remove('print-gantt');
            }, 100);
        }

        window.addEventListener('afterprint', () => {
            document.body.classList.remove('print-weekly', 'print-gantt');
        });

        const WORK_HOURS_PER_DAY = 4;
        const colorPalette = [
            '#00f3ff', // Neon Cyan
            '#ff00ea', // Neon Magenta
            '#fcee0a', // Neon Yellow
            '#00ff66', // Neon Green
            '#9333ea', // Electric Purple
            '#f97316', // Bright Orange
            '#3b82f6', // Bright Blue
            '#ef4444', // Neon Red
            '#10b981', // Emerald Green
            '#ec4899', // Pink
            '#06b6d4', '#84cc16', '#6366f1', '#a855f7', '#d946ef'
        ];
        
        const iconOptions = [
            { id: 'fa-flag', label: 'フラッグ' }, { id: 'fa-pen-ruler', label: '設計/ペン' },
            { id: 'fa-file-export', label: '出図/ファイル' }, { id: 'fa-wrench', label: '製作/ツール' },
            { id: 'fa-vial', label: '試験/テスト' }, { id: 'fa-handshake', label: '立会/確認' },
            { id: 'fa-truck-fast', label: '出荷/トラック' }, { id: 'fa-star', label: 'スター' },
            { id: 'fa-circle-exclamation', label: '注意/重要' }
        ];

        const dateUtils = {
            getDatesBetween: (start, end) => {
                const dates = []; let curr = new Date(start); const e = new Date(end);
                while (curr <= e) { dates.push(new Date(curr)); curr.setDate(curr.getDate() + 1); }
                return dates;
            },
            getStartOfWeek: (dateStr) => {
                const d = dateStr ? new Date(dateStr) : new Date();
                const day = d.getDay();
                const diff = d.getDate() - day + (day === 0 ? -6 : 1);
                return new Date(d.setDate(diff));
            },
            formatDate: (date) => {
                return date.getFullYear() + '-' + String(date.getMonth()+1).padStart(2,'0') + '-' + String(date.getDate()).padStart(2,'0');
            },
            getJapaneseDay: (date) => {
                return ['日', '月', '火', '水', '木', '金', '土'][date.getDay()];
            },
            addBusinessDays: (dateStr, days) => {
                let d = new Date(dateStr);
                let count = 0;
                let step = days >= 0 ? 1 : -1;
                let target = Math.abs(days);
                while (count < target) {
                    d.setDate(d.getDate() + step);
                    if (isBusinessDay(d)) count++;
                }
                return dateUtils.formatDate(d);
            }
        };

        state.weeklyBaseDate = dateUtils.formatDate(dateUtils.getStartOfWeek());

        function calculateStartDate(dueDateStr, totalHours, excludeTaskId = null) {
            if (!dueDateStr) return '';
            if (totalHours <= 0) return dueDateStr;

            const dailyTaskCount = {};
            state.tasks.forEach(t => {
                if (t.id === excludeTaskId) return;
                if (t.startDate && t.dueDate && t.totalHours > 0) {
                    const ts = new Date(t.startDate).setHours(0,0,0,0);
                    const te = new Date(t.dueDate).setHours(0,0,0,0);
                    for(let time=ts; time<=te; time+=86400000) {
                        const d = new Date(time);
                        if(isBusinessDay(d)) {
                            const key = dateUtils.formatDate(d);
                            dailyTaskCount[key] = (dailyTaskCount[key] || 0) + 1;
                        }
                    }
                }
            });

            let currentDate = new Date(dueDateStr);
            let remainingHours = totalHours;

            while (!isBusinessDay(currentDate)) currentDate.setDate(currentDate.getDate() - 1);

            while (remainingHours > 0) {
                if (isBusinessDay(currentDate)) {
                    const key = dateUtils.formatDate(currentDate);
                    const otherTasksCount = dailyTaskCount[key] || 0;
                    let available = WORK_HOURS_PER_DAY / (otherTasksCount + 1);
                    if (available < 0.5) available = 0.5;
                    remainingHours -= available;
                    if (remainingHours <= 0) break;
                }
                currentDate.setDate(currentDate.getDate() - 1);
            }
            return dateUtils.formatDate(currentDate);
        }

        function isDelayed(task) {
            if (task.status !== 'todo' || !task.startDate) return false;
            const today = new Date(); today.setHours(0,0,0,0);
            const start = new Date(task.startDate); start.setHours(0,0,0,0);
            return start < today;
        }

        function isOverdue(task) {
            if (task.status === 'done' || !task.dueDate) return false;
            const today = new Date(); today.setHours(0,0,0,0);
            const due = new Date(task.dueDate); due.setHours(0,0,0,0);
            return due < today;
        }

        function switchView(view) {
            if (view === 'weekly' && state.currentView !== 'weekly') {
                showDialog(
                    '確認', 
                    '日曜日までの進捗率の記入はお済みですか？\n※現在の進捗率をもとに、翌週の割り当て可能な残工数を算出します。', 
                    'info', 
                    () => { executeSwitchView(view); }, 
                    () => {}
                );
            } else {
                executeSwitchView(view);
            }
        }

        function executeSwitchView(view) {
            state.currentView = view;
            
            ['kanban', 'gantt', 'weekly'].forEach(v => {
                const tab = document.getElementById(`tab-${v}`);
                const viewEl = document.getElementById(`view-${v}`);
                if (v === view) {
                    tab.className = "px-6 py-2.5 rounded-lg text-sm font-bold uppercase tracking-widest transition-all bg-cyan-600 text-white shadow-md border-2 border-cyan-500/20";
                    viewEl.classList.remove('hidden');
                } else {
                    tab.className = "px-6 py-2.5 rounded-lg text-sm font-bold uppercase tracking-widest transition-all text-slate-400 hover:text-cyan-600 hover:bg-white";
                    viewEl.classList.add('hidden');
                }
            });
            refreshCurrentView();
        }

        function updateProjectFilters() {
            const kanbanSelect = document.getElementById('kanban-project-filter');
            const weeklySelect = document.getElementById('weekly-project-filter');

            const renderOptions = (currentValue) => {
                let html = '<option value="all">すべての案件</option>';
                const sorted = [...state.projects].sort((a, b) => {
                    const compA = isProjectCompleted(a.id);
                    const compB = isProjectCompleted(b.id);
                    if (compA !== compB) return compA ? 1 : -1;
                    return getProjectDueDate(a) - getProjectDueDate(b);
                });

                sorted.forEach(p => {
                    const isCompleted = isProjectCompleted(p.id);
                    if (!isCompleted || state.showCompletedProjects || currentValue === p.id) {
                        html += `<option value="${p.id}" ${currentValue === p.id ? 'selected' : ''} class="${isCompleted ? 'text-slate-500' : ''}">${p.name}${isCompleted ? ' (完了)' : ''}</option>`;
                    }
                });
                return html;
            };

            if (kanbanSelect) kanbanSelect.innerHTML = renderOptions(kanbanSelect.value);
            if (weeklySelect) weeklySelect.innerHTML = renderOptions(weeklySelect.value);
        }

        function changeWeek(offset) {
            const d = new Date(state.weeklyBaseDate);
            d.setDate(d.getDate() + (offset * 7));
            state.weeklyBaseDate = dateUtils.formatDate(d);
            renderWeekly();
        }

        function toggleSubtaskNote(id, iconId) {
            const el = document.getElementById(id);
            const icon = document.getElementById(iconId);
            if(el.classList.contains('hidden')) {
                el.classList.remove('hidden');
                icon.classList.add('text-indigo-600');
            } else {
                el.classList.add('hidden');
                icon.classList.remove('text-indigo-600');
            }
        }

        function resetToCurrentWeek() {
            state.weeklyBaseDate = dateUtils.formatDate(dateUtils.getStartOfWeek());
            renderWeekly();
        }

        function toggleAccordion(id, iconId) {
            const el = document.getElementById(id);
            const icon = document.getElementById(iconId);
            if(el.classList.contains('hidden')) {
                el.classList.remove('hidden');
                icon.classList.remove('fa-chevron-right');
                icon.classList.add('fa-chevron-down');
            } else {
                el.classList.add('hidden');
                icon.classList.remove('fa-chevron-down');
                icon.classList.add('fa-chevron-right');
            }
        }

        function renderWeekly() {
            renderAdHocTemplates();
            const baseDate = new Date(state.weeklyBaseDate);
            const endDate = new Date(baseDate);
            endDate.setDate(endDate.getDate() + 6);
            const rangeEl = document.getElementById('weekly-current-date-range');
            if (rangeEl) {
                const startStr = `${baseDate.getFullYear()}/${baseDate.getMonth() + 1}/${baseDate.getDate()}`;
                const endStr = `${endDate.getFullYear()}/${endDate.getMonth() + 1}/${endDate.getDate()}`;
                rangeEl.innerText = `${startStr} 〜 ${endStr}`;
            }

            const pId = document.getElementById('weekly-project-filter').value;
            
            const weekDatesStr = [];
            for (let i = 0; i < 7; i++) {
                const d = new Date(baseDate); d.setDate(d.getDate() + i);
                weekDatesStr.push(dateUtils.formatDate(d));
            }

            const wStartMs = baseDate.getTime();
            const wEndMs = new Date(endDate).setHours(23,59,59,999);

            let relevantTasks = [];
            let irrelevantTasks = [];

            state.tasks.filter(t => {
                if (t.status === 'done') return false;
                if (pId !== 'all' && t.projectId !== pId) return false;
                if (!state.showCompletedProjects && isProjectCompleted(t.projectId)) return false;
                return true;
            }).forEach(t => {
                let hasUnassigned = false;
                t.subtasks.forEach(st => {
                    if (!st.completed) {
                        hasUnassigned = true;
                    }
                });

                if (!hasUnassigned) return;

                let isRelevantThisWeek = false;
                if (t.startDate || t.dueDate) {
                    const tStart = t.startDate ? new Date(t.startDate).getTime() : 0;
                    const tEnd = t.dueDate ? new Date(t.dueDate).setHours(23,59,59,999) : 9999999999999;
                    if ((tStart <= wEndMs && tEnd >= wStartMs) || tEnd < wStartMs) {
                        isRelevantThisWeek = true;
                    }
                }

                if (isRelevantThisWeek) relevantTasks.push(t);
                else irrelevantTasks.push(t);
            });

            const sortByProjectAndDueDate = (a, b) => {
                const pA = state.projects.find(p => p.id === a.projectId);
                const pB = state.projects.find(p => p.id === b.projectId);
                const nameA = pA ? pA.name : 'zzzz';
                const nameB = pB ? pB.name : 'zzzz';
                if (nameA !== nameB) {
                    return nameA.localeCompare(nameB, 'ja');
                }
                const da = a.dueDate ? new Date(a.dueDate).getTime() : 9999999999999;
                const db = b.dueDate ? b.dueDate : 9999999999999;
                return da - db;
            };

            relevantTasks.sort(sortByProjectAndDueDate);
            irrelevantTasks.sort(sortByProjectAndDueDate);

            const poolContainer = document.getElementById('weekly-unassigned-pool');
            poolContainer.innerHTML = '';

            const renderTaskGroup = (task, isOpen) => {
                const project = state.projects.find(p => p.id === task.projectId);
                const pColor = project ? project.color : '#9ca3af';
                const pName = project ? project.name : '所属なし';

                const overdue = isOverdue(task);
                const titleClass = overdue ? 'text-fuchsia-700' : 'text-slate-800';
                const dateClass = overdue ? 'text-fuchsia-600 font-black' : 'text-slate-500';

                let targetProg = 0;
                if (task.startDate && task.dueDate) {
                    const start = new Date(task.startDate).getTime();
                    const end = new Date(task.dueDate).getTime();
                    const totalD = end - start;
                    if (totalD > 0) targetProg = Math.max(0, Math.min(100, Math.round((wEndMs - start) / totalD * 100)));
                } else if (task.dueDate && new Date(task.dueDate).getTime() <= wEndMs) {
                    targetProg = 100;
                }

                const totalH = task.totalHours || 1;
                const completedHSum = task.subtasks.reduce((sum, s) => sum + (s.hours * ((s.progress||0)/100)), 0);
                const assignedHThisWeek = task.subtasks.reduce((sum, s) => {
                    return sum + s.assignments.filter(a => weekDatesStr.includes(a.date)).reduce((asum, a) => asum + a.duration * 0.5, 0);
                }, 0);
                const plannedProg = Math.min(100, Math.round((completedHSum + assignedHThisWeek) / totalH * 100));
                const progColor = (plannedProg < targetProg && targetProg > 0) ? 'text-fuchsia-600' : 'text-cyan-700';

                let stHtml = '';
                let totalRemH = 0;
                task.subtasks.forEach(st => {
                    if (st.completed) return;
                    const completedH = st.hours * ((st.progress||0) / 100);
                    const remH = parseFloat(Math.max(0, st.hours - completedH).toFixed(1));

                    totalRemH += remH;

                    stHtml += `
                        <div class="p-3 pl-4 bg-white border-2 border-slate-100 hover:border-cyan-500/30 rounded-xl shadow-sm flex flex-col gap-1 group cursor-grab active:cursor-grabbing transition-all"
                             draggable="true" ondragstart="dragStartWeeklyPool(event, '${task.id}', '${st.id}', ${remH})"
                             ondblclick="openTaskModal('${task.id}')">
                             <div class="flex items-center justify-between">
                                 <div class="flex items-center gap-3 flex-1 overflow-hidden text-xs font-mono">
                                     <i class="fa-solid fa-grip-vertical text-slate-200 group-hover:text-cyan-500 transition-colors"></i>
                                     <span class="truncate text-slate-700 font-black uppercase tracking-tight">${st.title}</span>
                                 </div>
                                 <span class="bg-slate-800 text-white font-bold border-2 border-slate-800 px-2 py-0.5 rounded-lg text-[10px] ml-3 shrink-0 shadow-sm">${remH}h</span>
                             </div>
                        </div>
                    `;
                });

                if (stHtml) {
                    const accDiv = document.createElement('div');
                    accDiv.className = "mb-4 bg-white border-2 border-slate-200 rounded-2xl overflow-hidden shadow-sm";
                    accDiv.innerHTML = `
                        <div class="px-4 py-3 bg-slate-50 border-b-2 border-transparent flex items-center justify-between cursor-pointer hover:bg-white transition-all" onclick="toggleAccordion('acc-${task.id}', 'icon-${task.id}')">
                            <div class="flex flex-col flex-1 pr-4">
                                <div class="flex items-center gap-3 overflow-hidden mb-1.5">
                                    <span class="w-3 h-3 rounded-full flex-shrink-0 shadow-sm" style="background-color: ${pColor}"></span>
                                    <span class="text-xs font-black ${titleClass} truncate font-mono uppercase tracking-tight">${task.title}</span>
                                </div>
                                <div class="flex justify-between items-center pl-6">
                                    <div class="text-[10px] font-bold ${dateClass} uppercase tracking-tighter">納期: ${task.dueDate ? task.dueDate.substring(5).replace('-','/') : '未設定'}</div>
                                    <span class="text-[10px] font-bold ${progColor} uppercase tracking-tighter bg-white px-2 py-0.5 rounded border border-slate-100">
                                        目標:${targetProg}% / 予定:${plannedProg}%
                                    </span>
                                </div>
                            </div>
                            <div class="flex items-center gap-3">
                                <span class="text-xs font-bold text-cyan-700">${parseFloat(totalRemH.toFixed(1))}h</span>
                                <i id="icon-${task.id}" class="fa-solid ${isOpen ? 'fa-chevron-down' : 'fa-chevron-right'} text-slate-300 text-xs w-4 text-center transition-transform"></i>
                            </div>
                        </div>
                        <div id="acc-${task.id}" class="p-3 space-y-2 bg-slate-50/50 ${isOpen ? '' : 'hidden'}">
                            ${stHtml}
                        </div>
                    `;
                    poolContainer.appendChild(accDiv);
                }
            };

            relevantTasks.forEach(t => renderTaskGroup(t, true));

            if (irrelevantTasks.length > 0) {
                const divider = document.createElement('div');
                divider.className = "mt-8 mb-4 flex items-center gap-3";
                divider.innerHTML = `
                    <div class="h-0.5 bg-slate-200 flex-1"></div>
                    <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">待機中のタスク</span>
                    <div class="h-0.5 bg-slate-200 flex-1"></div>
                `;
                poolContainer.appendChild(divider);

                irrelevantTasks.forEach(t => renderTaskGroup(t, false));
            }

            const calContainer = document.getElementById('weekly-calendar-board');
            calContainer.innerHTML = '';

            for (let i = 0; i < 7; i++) {
                const targetDate = new Date(baseDate);
                targetDate.setDate(targetDate.getDate() + i);
                const dateStr = dateUtils.formatDate(targetDate);
                const dayStr = dateUtils.getJapaneseDay(targetDate);
                const isHol = !isBusinessDay(targetDate);
                const isToday = dateStr === dateUtils.formatDate(new Date());

                let dailyAssignedH = 0;
                let blocksHtml = '';

                state.tasks.forEach(t => {
                    if (pId !== 'all' && t.projectId !== pId) return;
                    if (!state.showCompletedProjects && isProjectCompleted(t.projectId)) return;

                    const proj = state.projects.find(p => p.id === t.projectId);
                    const pColor = proj ? proj.color : '#9ca3af';
                    const overdue = isOverdue(t);

                    t.subtasks.forEach(st => {
                        st.assignments.forEach(a => {
                            if (a.date === dateStr) {
                                dailyAssignedH += a.duration * 0.5;
                                const borderCol = overdue ? '#d946ef' : pColor;

                                blocksHtml += `
                                    <div class="absolute left-14 right-2 rounded-lg border-2 shadow-md group overflow-hidden cursor-grab active:cursor-grabbing hover:scale-[1.02] transition-all z-10"
                                         style="top: calc(${a.startSlot} * var(--slot-height)); height: calc(${a.duration} * var(--slot-height)); background-color: ${pColor}10; border-color: ${borderCol}60; box-shadow: 0 4px 10px rgba(0,0,0,0.05);"
                                         draggable="true" ondragstart="dragStartWeeklyTimeline(event, '${t.id}', '${st.id}', '${a.date}', ${a.startSlot}, ${a.duration})">
                                        <div class="absolute left-0 top-0 bottom-0 w-1.5" style="background-color: ${pColor}; shadow: 2px 0 5px rgba(0,0,0,0.1);"></div>
                                        <div class="pl-4 pt-1.5 pr-8 text-slate-800 leading-tight w-full h-full overflow-hidden font-mono font-bold">
                                            <div class="truncate text-[10px] ${overdue ? 'text-fuchsia-600 font-black' : 'text-slate-400 font-black'} uppercase tracking-tighter">${t.title}</div>
                                            <div class="${a.duration === 1 ? 'truncate' : 'line-clamp-2'} text-[12px] mt-1 uppercase text-slate-700">${st.title}</div>
                                        </div>
                                        <button onclick="unassignBlock('${t.id}', '${st.id}', '${a.date}', ${a.startSlot})" class="absolute top-1.5 right-1.5 text-slate-300 hover:text-fuchsia-600 bg-white/80 rounded-md border-2 border-slate-100 w-5 h-5 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all z-20 shadow-sm">
                                            <i class="fa-solid fa-xmark text-[10px]"></i>
                                        </button>
                                    </div>
                                `;
                            }
                        });
                    });
                });

                const isOverloaded = dailyAssignedH > WORK_HOURS_PER_DAY;
                const percent = Math.min(100, (dailyAssignedH / 8) * 100);
                const barColor = isOverloaded ? 'bg-fuchsia-500 shadow-[0_0_10px_rgba(217,70,239,0.3)]' : 'bg-cyan-500 shadow-[0_0_10px_rgba(14,165,233,0.3)]';
                const headerBg = isToday ? 'bg-white border-cyan-500 border-4 shadow-xl' : (isHol ? 'bg-slate-100' : 'bg-white');

                let slotsHtml = '';
                for(let s=0; s<18; s++) {
                    const timeStr = s % 2 === 0 ? `${9 + Math.floor(s/2)}:00` : '';
                    const borderClass = s % 2 === 0 ? 'border-slate-100 border-dashed' : 'border-slate-200';
                    const isLunch = (s === 6 || s === 7);
                    const bgClass = isLunch ? 'bg-slate-50' : '';
                    
                    slotsHtml += `
                        <div class="border-b ${borderClass} flex w-full box-border relative ${bgClass}" style="height: var(--slot-height);">
                            <div class="w-14 text-[11px] font-mono font-black text-slate-300 text-right pr-3 border-r-2 border-slate-100 pt-2">${timeStr}</div>
                            <div class="flex-1 relative"></div>
                        </div>
                    `;
                }

                const colDiv = document.createElement('div');
                colDiv.className = `flex flex-col w-[300px] flex-shrink-0 border-2 border-slate-200 rounded-2xl overflow-hidden bg-white shadow-sm transition-all`;
                
                colDiv.innerHTML = `
                    <div class="px-5 py-4 border-b-2 border-slate-100 ${headerBg} flex flex-col gap-3 z-20 sticky top-0 bg-opacity-95 backdrop-blur transition-all">
                        <div class="flex justify-between items-center font-mono">
                            <span class="font-black flex items-center gap-2 ${isToday ? 'text-cyan-700 scale-105' : (isHol ? 'text-slate-300' : 'text-slate-600')} text-sm uppercase tracking-tight">
                                ${targetDate.getMonth()+1}.${targetDate.getDate()} (${dayStr})
                                ${isOverloaded ? `<i class="fa-solid fa-triangle-exclamation text-fuchsia-500 text-xs"></i>` : ''}
                            </span>
                            <span class="text-xs font-black ${isOverloaded ? 'text-fuchsia-600' : 'text-slate-400'}">
                                ${dailyAssignedH}<span class="text-[10px] opacity-40">/8h</span>
                            </span>
                        </div>
                        <div class="w-full bg-slate-100 rounded-full h-2 overflow-hidden border-2 border-slate-50">
                            <div class="${barColor} h-2 rounded-full transition-all duration-700 ease-out" style="width: ${percent}%"></div>
                        </div>
                    </div>
                    <div class="relative w-full overflow-y-hidden overflow-x-hidden ${isHol ? 'holiday-bg' : ''}"
                         style="height: calc(18 * var(--slot-height));"
                         ondragover="allowWeeklyDropContainer(event)" 
                         ondragleave="dragWeeklyLeaveContainer(event)" 
                         ondrop="dropWeeklyContainer(event, '${dateStr}')">
                        
                        <div class="absolute inset-0 z-0 pointer-events-none">
                            ${slotsHtml}
                        </div>
                        ${blocksHtml}
                        <div class="drop-overlay absolute inset-0 bg-cyan-500/5 opacity-0 pointer-events-none transition-opacity z-30"></div>
                    </div>
                `;
                calContainer.appendChild(colDiv);
            }
        }

        function dragStartWeeklyPool(ev, taskId, subtaskId, remainingHours) {
            const duration = remainingHours >= 1 ? 2 : 1; 
            ev.dataTransfer.setData("text/plain", JSON.stringify({ type: 'from_pool', taskId, subtaskId, duration }));
        }

        function dragStartWeeklyTimeline(ev, taskId, subtaskId, dateStr, startSlot, duration) {
            ev.dataTransfer.setData("text/plain", JSON.stringify({ type: 'from_timeline', taskId, subtaskId, dateStr, startSlot, duration }));
        }

        function allowWeeklyDropContainer(ev) {
            ev.preventDefault();
            const overlay = ev.currentTarget.querySelector('.drop-overlay');
            if(overlay) overlay.classList.add('opacity-100');
        }

        function dragWeeklyLeaveContainer(ev) {
            const overlay = ev.currentTarget.querySelector('.drop-overlay');
            if(overlay) overlay.classList.remove('opacity-100');
        }

        function dropWeeklyContainer(ev, targetDateStr) {
            ev.preventDefault();
            const overlay = ev.currentTarget.querySelector('.drop-overlay');
            if(overlay) overlay.classList.remove('opacity-100');
            
            const dataStr = ev.dataTransfer.getData("text/plain");
            if(!dataStr) return;
            const data = JSON.parse(dataStr);
            
            const rect = ev.currentTarget.getBoundingClientRect();
            const y = ev.clientY - rect.top;
            let slotIndex = Math.floor(y / 48); 
            if (slotIndex < 0) slotIndex = 0;
            if (slotIndex > 15) slotIndex = 15;

            processWeeklyDrop(data, targetDateStr, slotIndex);
        }

        async function processWeeklyDrop(data, targetDateStr, slotIndex) {
            const duration = data.duration;
            
            if (slotIndex + duration > 18) {
                showDialog('エラー', '18:00を超えて配置することはできません。', 'error');
                return;
            }
            
            for (let s = slotIndex; s < slotIndex + duration; s++) {
                if (s === 6 || s === 7) {
                    showDialog('エラー', '12:00～13:00は昼休憩のため配置できません。', 'error');
                    return;
                }
            }

            if (data.type === 'adhoc') {
                let taskTitle = data.name;
                if (data.isFree) {
                    taskTitle = prompt("タスク名を入力してください", "臨時タスク");
                    if (!taskTitle) return;
                }
                
                const newId = generateId();
                const adhocTask = {
                    id: newId,
                    projectId: 'adhoc-project',
                    title: taskTitle,
                    status: 'in_progress',
                    dueDate: targetDateStr,
                    startDate: targetDateStr,
                    totalHours: duration * 0.5,
                    notes: '臨時タスク',
                    subtasks: [{ id: generateId(), title: '作業', hours: duration * 0.5, progress: 0, completed: false, assignments: [{ id: generateId(), date: targetDateStr, startSlot: slotIndex, duration: duration }] }]
                };
                
                if (!state.projects.find(p => p.id === 'adhoc-project')) {
                    await saveDoc('projects', 'adhoc-project', { id: 'adhoc-project', name: '臨時・事務', color: '#9ca3af', milestones: [] });
                }
                
                await saveDoc('tasks', newId, adhocTask);
                return;
            }
            
            let isOverlap = false;
            state.tasks.forEach(t => t.subtasks.forEach(st => {
                st.assignments.forEach(a => {
                    if (a.date === targetDateStr) {
                        if (data.type === 'from_timeline' && a.date === data.dateStr && a.startSlot === data.startSlot && st.id === data.subtaskId) {
                            return; 
                        }
                        if (slotIndex < a.startSlot + a.duration && a.startSlot < slotIndex + duration) {
                            isOverlap = true;
                        }
                    }
                });
            }));
            
            if (isOverlap) {
                showDialog('エラー', '指定された時間はすでに他のタスクが割り当てられています。', 'warning');
                return;
            }
            
            const task = state.tasks.find(t => t.id === data.taskId);
            const subtask = task.subtasks.find(s => s.id === data.subtaskId);
            
            if (data.type === 'from_timeline') {
                const idx = subtask.assignments.findIndex(a => a.date === data.dateStr && a.startSlot === data.startSlot);
                if(idx >= 0) subtask.assignments.splice(idx, 1);
            }
            
            subtask.assignments.push({ id: generateId(), date: targetDateStr, startSlot: slotIndex, duration: duration });
            if (task.status === 'todo') task.status = 'in_progress';
            
            mergeAssignments(subtask);
            
            await saveDoc('tasks', task.id, task);
        }

        function mergeAssignments(subtask) {
            subtask.assignments.sort((a, b) => {
                if (a.date !== b.date) return a.date.localeCompare(b.date);
                return a.startSlot - b.startSlot;
            });
            
            for (let i = 0; i < subtask.assignments.length - 1; i++) {
                let curr = subtask.assignments[i];
                let next = subtask.assignments[i+1];
                if (curr.date === next.date && curr.startSlot + curr.duration === next.startSlot) {
                    curr.duration += next.duration;
                    subtask.assignments.splice(i+1, 1);
                    i--; 
                }
            }
        }

        async function unassignBlock(taskId, subtaskId, dateStr, startSlot) {
            const task = state.tasks.find(t => t.id === taskId);
            if(task) {
                // If it's an ad-hoc task, delete it entirely when unassigned
                if (task.projectId === 'adhoc-project') {
                    await deleteDocById('tasks', taskId);
                    return;
                }
                const subtask = task.subtasks.find(s => s.id === subtaskId);
                if(subtask) {
                    const idx = subtask.assignments.findIndex(a => a.date === dateStr && a.startSlot === startSlot);
                    if(idx >= 0) {
                        subtask.assignments.splice(idx, 1);
                        await saveDoc('tasks', task.id, task);
                    }
                }
            }
        }

        function dropToPool(ev) {
            ev.preventDefault();
            const dataStr = ev.dataTransfer.getData("text/plain");
            if(!dataStr) return;
            const data = JSON.parse(dataStr);
            
            if (data.type === 'from_timeline') {
                unassignBlock(data.taskId, data.subtaskId, data.dateStr, data.startSlot);
            }
        }

        function showModal(id) {
            document.getElementById('modal-overlay').classList.remove('hidden');
            const m = document.getElementById(id); m.classList.remove('hidden');
            setTimeout(() => { m.classList.remove('scale-95', 'opacity-0'); m.classList.add('scale-100', 'opacity-100'); }, 10);
        }

        function closeModal(id) {
            const m = document.getElementById(id); m.classList.remove('scale-100', 'opacity-100'); m.classList.add('scale-95', 'opacity-0');
            setTimeout(() => {
                m.classList.add('hidden');
                if (Array.from(document.getElementById('modal-overlay').children).every(el => el.classList.contains('hidden'))) {
                    document.getElementById('modal-overlay').classList.add('hidden');
                }
            }, 200);
        }

        function showDialog(title, msg, type = 'info', onConf = null, onCanc = null) {
            const m = document.getElementById('dialog-modal');
            const t = document.getElementById('dialog-title');
            const dmsg = document.getElementById('dialog-message');
            const w = document.getElementById('dialog-icon');
            const b = document.getElementById('dialog-buttons');

            t.innerText = title; dmsg.innerText = msg;
            b.innerHTML = '';
            
            w.className = "mx-auto flex items-center justify-center h-16 w-16 rounded-full mb-6 border-2 transition-all duration-500 shadow-[0_0_15px_rgba(0,0,0,0.3)]";
            if (type === 'error') {
                w.innerHTML = '<i class="fa-solid fa-triangle-exclamation text-2xl"></i>';
                w.classList.add('border-fuchsia-500', 'text-fuchsia-500', 'bg-fuchsia-500/10', 'shadow-[0_0_15px_rgba(255,0,234,0.3)]');
                t.className = "text-lg font-black neon-text-pink uppercase tracking-widest mb-2";
            } else if (type === 'warning') {
                w.innerHTML = '<i class="fa-solid fa-circle-exclamation text-2xl"></i>';
                w.classList.add('border-amber-500', 'text-amber-500', 'bg-amber-500/10', 'shadow-[0_0_15px_rgba(245,158,11,0.3)]');
                t.className = "text-lg font-black text-amber-500 uppercase tracking-widest mb-2";
            } else {
                w.innerHTML = '<i class="fa-solid fa-circle-info text-2xl"></i>';
                w.classList.add('border-cyan-500', 'text-cyan-500', 'bg-cyan-500/10', 'shadow-[0_0_15px_rgba(0,243,255,0.3)]');
                t.className = "text-lg font-black neon-text-blue uppercase tracking-widest mb-2";
            }

            if (onCanc) {
                const c = document.createElement('button');
                c.className = "px-6 py-2.5 border border-slate-700 rounded-lg text-xs font-bold text-slate-500 hover:bg-slate-800 transition-all uppercase tracking-widest";
                c.innerText = "キャンセル";
                c.onclick = () => { closeModal('dialog-modal'); onCanc(); };
                b.appendChild(c);
            }
            const o = document.createElement('button');
            const btnClass = type === 'error' ? 'neon-border-pink text-fuchsia-400 bg-fuchsia-500/5 hover:bg-fuchsia-500/20' : 'btn-cyber-blue';
            o.className = `px-8 py-2.5 rounded-lg text-xs font-black transition-all uppercase tracking-widest ${btnClass}`;
            o.innerText = onCanc ? "実行する" : "了解";
            o.onclick = () => { closeModal('dialog-modal'); if(onConf) onConf(); };
            b.appendChild(o);

            showModal('dialog-modal');
        }

        function updateProjectTemplatesDropdown() {
            const sel = document.getElementById('proj-template-selector');
            if(sel) sel.innerHTML = '<option value="">-- 選択 --</option>' + state.projectTemplates.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
        }

        function toggleProjTemplateSelect() {
            const isTemp = document.querySelector('input[name="proj_type"][value="template"]').checked;
            document.getElementById('proj-template-selector-wrapper').classList.toggle('hidden', !isTemp);
        }

        function deleteProjectTemplate() {
            const tempId = document.getElementById('proj-template-selector').value;
            if(!tempId) { showDialog('エラー', '削除するテンプレートを選択してください。', 'warning'); return; }
            showDialog('確認', '選択した案件テンプレートを削除しますか？', 'warning', async () => {
                await deleteDocById('projectTemplates', tempId);
            }, () => {});
        }

        function openProjectModal(isEdit = false) {
            const isEditMode = isEdit && editingProjectId;
            document.getElementById('project-modal-title').innerText = isEditMode ? '案件の編集' : '案件の登録';
            document.getElementById('project-creation-type-container').classList.toggle('hidden', isEditMode);
            document.getElementById('btn-save-proj-tmpl').classList.toggle('hidden', !isEditMode);
            document.getElementById('btn-delete-proj').classList.toggle('hidden', !isEditMode);
            document.getElementById('btn-complete-proj').classList.toggle('hidden', !isEditMode);
            
            if (isEditMode) {
                const p = state.projects.find(x => x.id === editingProjectId);
                document.getElementById('project-name-input').value = p.name;
                editingMilestones = JSON.parse(JSON.stringify(p.milestones || []));
                
                const isComp = p.status === 'completed';
                document.getElementById('text-complete-proj').innerText = isComp ? '案件を進行中に戻す' : '案件を完了にする';
                document.getElementById('icon-complete-proj').className = isComp ? 'fa-solid fa-rotate-left' : 'fa-solid fa-box-archive';
            } else {
                editingProjectId = null;
                document.getElementById('project-name-input').value = '';
                document.querySelector('input[name="proj_type"][value="blank"]').checked = true;
                toggleProjTemplateSelect();
                editingMilestones = JSON.parse(JSON.stringify(defaultMilestonesTemplate));
            }
            renderMilestonesSettings();
            showModal('project-modal');
        }

        async function toggleProjectStatus() {
            if (!editingProjectId) return;
            const p = state.projects.find(x => x.id === editingProjectId);
            const isCurrentlyCompleted = p.status === 'completed';
            
            p.status = isCurrentlyCompleted ? 'active' : 'completed';
            await saveDoc('projects', p.id, p);
            
            closeModal('project-modal');
            showDialog('完了', `案件を「${isCurrentlyCompleted ? '進行中' : '完了'}」にしました。`, 'info');
            refreshCurrentView();
        }

        function editCurrentProject() {
            const pid = document.getElementById('kanban-project-filter').value;
            if (pid === 'all') { showDialog('案内', '編集する案件を選択してください。', 'warning'); return; }
            editingProjectId = pid;
            openProjectModal(true);
        }

        async function saveProjectAsTemplate() {
            if (!editingProjectId) return;
            const p = state.projects.find(x => x.id === editingProjectId);
            const pTasks = state.tasks.filter(t => t.projectId === p.id);
            const tmpl = {
                id: generateId(), name: p.name + ' (テンプレ)', 
                milestones: JSON.parse(JSON.stringify(p.milestones)),
                tasks: pTasks.map(t => ({ 
                    title: t.title, 
                    totalHours: t.totalHours, 
                    subtasks: t.subtasks.map(s => ({title: s.title, hours: s.hours, notes: s.notes || ''})) 
                }))
            };
            await saveDoc('projectTemplates', tmpl.id, tmpl);
            showDialog('完了', 'この案件をテンプレートとして保存しました。', 'info');
        }

        function openProjectTemplateModal() {
            const tempId = document.getElementById('proj-template-selector').value;
            if (!tempId) { showDialog('案内', '編集するテンプレートを選択してください。', 'warning'); return; }
            
            const tmpl = state.projectTemplates.find(t => t.id === tempId);
            if (!tmpl) return;

            editingTemplate = JSON.parse(JSON.stringify(tmpl));
            document.getElementById('template-name-input').value = editingTemplate.name;
            
            renderTemplateMilestones();
            renderTemplateTasks();
            showModal('project-template-modal');
        }

        function renderTemplateMilestones() {
            const container = document.getElementById('template-milestones-container');
            container.innerHTML = '';

            editingTemplate.milestones.forEach((ms, idx) => {
                const row = document.createElement('div');
                row.className = "flex items-center gap-4 p-4 bg-slate-50 border-2 border-slate-100 rounded-2xl shadow-sm";
                row.innerHTML = `
                    <div class="flex flex-col gap-1 w-8 shrink-0">
                        <button onclick="moveTemplateMilestone(${idx}, -1)" class="text-slate-300 hover:text-cyan-500 ${idx===0?'invisible':''}"><i class="fa-solid fa-chevron-up"></i></button>
                        <button onclick="moveTemplateMilestone(${idx}, 1)" class="text-slate-300 hover:text-cyan-500 ${idx===editingTemplate.milestones.length-1?'invisible':''}"><i class="fa-solid fa-chevron-down"></i></button>
                    </div>
                    <div class="flex-1 grid grid-cols-1 md:grid-cols-3 gap-4">
                        <input type="text" value="${ms.name}" onchange="handleTemplateMilestoneChange(${idx}, 'name', this.value)" placeholder="工程名" class="bg-white border-2 border-slate-200 rounded-xl px-4 py-2 text-sm font-bold">
                        <select onchange="handleTemplateMilestoneChange(${idx}, 'type', this.value)" class="bg-white border-2 border-slate-200 rounded-xl px-4 py-2 text-sm font-bold">
                            <option value="point" ${ms.type==='point'?'selected':''}>特定の日付</option>
                            <option value="range" ${ms.type==='range'?'selected':''}>期間設定</option>
                        </select>
                        <select onchange="handleTemplateMilestoneChange(${idx}, 'icon', this.value)" class="bg-white border-2 border-slate-200 rounded-xl px-4 py-2 text-sm font-bold">
                            ${iconOptions.map(opt => `<option value="${opt.id}" ${ms.icon===opt.id?'selected':''}>${opt.label}</option>`).join('')}
                        </select>
                    </div>
                    <button onclick="removeTemplateMilestone(${idx})" class="text-slate-300 hover:text-red-500 px-2"><i class="fa-solid fa-trash-can text-lg"></i></button>
                `;
                container.appendChild(row);
            });
        }

        function addTemplateMilestone() {
            editingTemplate.milestones.push({ id: generateId(), name: '', type: 'point', icon: 'fa-flag', color: '#4b5563' });
            renderTemplateMilestones();
            renderTemplateTasks(); // Update target dropdowns
        }

        function removeTemplateMilestone(idx) {
            editingTemplate.milestones.splice(idx, 1);
            renderTemplateMilestones();
            renderTemplateTasks();
        }

        function moveTemplateMilestone(idx, dir) {
            const arr = editingTemplate.milestones;
            if (dir === -1 && idx > 0) [arr[idx], arr[idx-1]] = [arr[idx-1], arr[idx]];
            else if (dir === 1 && idx < arr.length - 1) [arr[idx], arr[idx+1]] = [arr[idx+1], arr[idx]];
            renderTemplateMilestones();
        }

        function handleTemplateMilestoneChange(idx, field, val) {
            editingTemplate.milestones[idx][field] = val;
            if (field === 'name' || field === 'type') renderTemplateTasks();
        }

        function renderTemplateTasks() {
            const container = document.getElementById('template-tasks-container');
            container.innerHTML = '';

            const msOptions = editingTemplate.milestones.map(m => `<option value="${m.name}">${m.name}</option>`).join('');
            const taskOptions = editingTemplate.tasks.map(t => `<option value="${t.title}">${t.title}</option>`).join('');

            editingTemplate.tasks.forEach((task, idx) => {
                const rel = task.relDate || { base: 'milestone', target: '', offset: 0 };
                const row = document.createElement('div');
                row.className = "p-6 bg-slate-50 border-2 border-slate-100 rounded-3xl space-y-4";
                row.innerHTML = `
                    <div class="flex justify-between items-center border-b border-slate-200 pb-3">
                        <span class="text-sm font-black text-slate-700">${task.title}</span>
                        <span class="text-[10px] font-bold text-slate-400">合計工数: ${task.totalHours}h</span>
                    </div>
                    <div class="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
                        <div>
                            <label class="block text-[10px] font-black text-slate-400 mb-2 uppercase">基準</label>
                            <select onchange="handleTemplateTaskChange(${idx}, 'base', this.value)" class="w-full bg-white border-2 border-slate-200 rounded-xl px-4 py-2 text-sm font-bold">
                                <option value="milestone" ${rel.base==='milestone'?'selected':''}>マイルストーン</option>
                                <option value="task" ${rel.base==='task'?'selected':''}>他のタスク</option>
                            </select>
                        </div>
                        <div>
                            <label class="block text-[10px] font-black text-slate-400 mb-2 uppercase">ターゲット</label>
                            <select onchange="handleTemplateTaskChange(${idx}, 'target', this.value)" class="w-full bg-white border-2 border-slate-200 rounded-xl px-4 py-2 text-sm font-bold">
                                <option value="">-- 選択 --</option>
                                ${rel.base === 'milestone' ? msOptions : taskOptions}
                            </select>
                        </div>
                        <div>
                            <label class="block text-[10px] font-black text-slate-400 mb-2 uppercase">オフセット（日）</label>
                            <input type="number" value="${rel.offset}" onchange="handleTemplateTaskChange(${idx}, 'offset', this.value)" class="w-full bg-white border-2 border-slate-200 rounded-xl px-4 py-2 text-sm font-bold">
                        </div>
                        <div class="flex items-center gap-2 pb-2">
                            <input type="checkbox" ${rel.useStart ? 'checked' : ''} onchange="handleTemplateTaskChange(${idx}, 'useStart', this.checked)" class="w-5 h-5 rounded border-slate-300 text-cyan-600 focus:ring-cyan-500">
                            <span class="text-[10px] font-bold text-slate-500">開始日を基準にする</span>
                        </div>
                    </div>
                `;
                // Set initial select value for target
                const targetSel = row.querySelectorAll('select')[1];
                targetSel.value = rel.target;
                container.appendChild(row);
            });
        }

        function handleTemplateTaskChange(taskIdx, field, val) {
            const task = editingTemplate.tasks[taskIdx];
            if (!task.relDate) task.relDate = { base: 'milestone', target: '', offset: 0, useStart: false };
            
            if (field === 'base') {
                task.relDate.base = val;
                task.relDate.target = '';
                renderTemplateTasks();
            } else if (field === 'target') {
                task.relDate.target = val;
            } else if (field === 'offset') {
                task.relDate.offset = parseInt(val) || 0;
            } else if (field === 'useStart') {
                task.relDate.useStart = !!val;
            }
        }

        async function saveProjectTemplate() {
            const name = document.getElementById('template-name-input').value.trim();
            if (!name) { showDialog('エラー', 'テンプレート名を入力してください。', 'error'); return; }
            
            editingTemplate.name = name;
            await saveDoc('projectTemplates', editingTemplate.id, editingTemplate);
            
            closeModal('project-template-modal');
            showDialog('完了', '案件テンプレートを保存しました。', 'info');
        }

        function deleteCurrentProject() {
            if(!editingProjectId) return;
            const p = state.projects.find(x => x.id === editingProjectId);
            
            // "Hassle" deletion: Require typing the project name
            const userInput = prompt(`案件「${p.name}」を完全に削除しますか？\n削除する場合は、確認のために案件名を正確に入力してください。`, "");
            
            if (userInput === p.name) {
                showDialog(
                    '最終確認', 
                    `本当に「${p.name}」を削除してもよろしいですか？\nこの操作は取り消せません。`, 
                    'error', 
                    async () => {
                        await deleteDocById('projects', editingProjectId);
                        const relatedTasks = state.tasks.filter(t => t.projectId === editingProjectId);
                        for (const t of relatedTasks) {
                            await deleteDocById('tasks', t.id);
                        }
                        
                        state.ganttSelectedProjects.delete(editingProjectId);
                        state.kanbanSelectedProjects.delete(editingProjectId);

                        closeModal('project-modal');
                        refreshCurrentView();
                    }, 
                    () => {}
                );
            } else if (userInput !== null) {
                showDialog('エラー', '案件名が一致しません。削除を中止しました。', 'warning');
            }
        }

        function addMilestoneRow() {
            editingMilestones.push({
                id: generateId(), name: '', type: 'point', icon: 'fa-flag', color: '#4b5563', date: '', startDate: '', endDate: ''
            });
            renderMilestonesSettings();
        }

        function removeMilestoneRow(idx) {
            editingMilestones.splice(idx, 1);
            renderMilestonesSettings();
        }
        
        function moveMilestone(idx, dir) {
            if (dir === -1 && idx > 0) {
                const temp = editingMilestones[idx]; editingMilestones[idx] = editingMilestones[idx-1]; editingMilestones[idx-1] = temp;
            } else if (dir === 1 && idx < editingMilestones.length - 1) {
                const temp = editingMilestones[idx]; editingMilestones[idx] = editingMilestones[idx+1]; editingMilestones[idx+1] = temp;
            }
            renderMilestonesSettings();
        }

        function handleMilestoneChange(idx, field, val) {
            editingMilestones[idx][field] = val;
            if (field === 'type') {
                editingMilestones[idx].date = ''; editingMilestones[idx].startDate = ''; editingMilestones[idx].endDate = '';
                renderMilestonesSettings();
            }
        }

        function renderMilestonesSettings() {
            const container = document.getElementById('milestones-container');
            container.innerHTML = '';

            editingMilestones.forEach((ms, idx) => {
                const row = document.createElement('div');
                row.className = `flex flex-wrap items-center gap-4 p-4 bg-white border-2 border-slate-100 rounded-2xl shadow-sm relative group milestone-row transition-all hover:border-cyan-200`;
                row.dataset.idx = idx;

                let dateInputHtml = '';
                if (ms.type === 'point') {
                    dateInputHtml = `
                        <div class="flex items-center gap-2">
                            <span class="text-[10px] font-black text-slate-400 uppercase">日付</span>
                            <input type="date" value="${ms.date}" onchange="handleMilestoneChange(${idx}, 'date', this.value)" class="bg-slate-50 border-2 border-slate-100 rounded-xl px-4 py-2 text-sm font-bold text-slate-700 focus:border-cyan-500 outline-none w-44 shadow-inner transition-all">
                        </div>`;
                } else {
                    dateInputHtml = `
                        <div class="flex items-center gap-3">
                            <div class="flex items-center gap-2">
                                <span class="text-[10px] font-black text-slate-400 uppercase">開始</span>
                                <input type="date" value="${ms.startDate}" onchange="handleMilestoneChange(${idx}, 'startDate', this.value)" class="bg-slate-50 border-2 border-slate-100 rounded-xl px-4 py-2 text-sm font-bold text-slate-700 focus:border-cyan-500 outline-none w-44 shadow-inner transition-all">
                            </div>
                            <span class="text-slate-300 font-bold">〜</span>
                            <div class="flex items-center gap-2">
                                <span class="text-[10px] font-black text-slate-400 uppercase">終了</span>
                                <input type="date" value="${ms.endDate}" onchange="handleMilestoneChange(${idx}, 'endDate', this.value)" class="bg-slate-50 border-2 border-slate-100 rounded-xl px-4 py-2 text-sm font-bold text-slate-700 focus:border-cyan-500 outline-none w-44 shadow-inner transition-all">
                            </div>
                        </div>`;
                }

                row.innerHTML = `
                    <div class="flex flex-col gap-1 w-8 shrink-0">
                        <button onclick="moveMilestone(${idx}, -1)" class="text-slate-300 hover:text-cyan-500 transition-colors ${idx===0?'invisible':''}"><i class="fa-solid fa-chevron-up text-lg"></i></button>
                        <button onclick="moveMilestone(${idx}, 1)" class="text-slate-300 hover:text-cyan-500 transition-colors ${idx===editingMilestones.length-1?'invisible':''}"><i class="fa-solid fa-chevron-down text-lg"></i></button>
                    </div>
                    <div class="flex-1 flex items-center gap-4 flex-nowrap min-w-[300px]">
                        <div class="flex-1 min-w-[180px]">
                            <span class="block text-[9px] font-black text-slate-400 mb-1 uppercase tracking-widest">工程名</span>
                            <input type="text" value="${ms.name}" onchange="handleMilestoneChange(${idx}, 'name', this.value)" placeholder="例：基本設計完了" class="w-full bg-transparent border-b-2 border-slate-100 focus:border-cyan-500 outline-none text-slate-800 text-sm font-bold py-1 transition-all">
                        </div>
                        <div class="shrink-0">
                            <span class="block text-[9px] font-black text-slate-400 mb-1 uppercase tracking-widest">形式</span>
                            <select onchange="handleMilestoneChange(${idx}, 'type', this.value)" class="bg-slate-50 border-2 border-slate-100 rounded-xl px-3 py-2 text-xs font-bold w-32 text-slate-600 focus:border-cyan-500 outline-none cursor-pointer appearance-none shadow-inner">
                                <option value="point" ${ms.type==='point'?'selected':''}>特定の日付</option>
                                <option value="range" ${ms.type==='range'?'selected':''}>期間設定</option>
                            </select>
                        </div>
                        <div class="shrink-0">
                            <span class="block text-[9px] font-black text-slate-400 mb-1 uppercase tracking-widest">アイコン</span>
                            <div class="flex items-center gap-2 border-2 border-slate-100 rounded-xl px-3 py-2 bg-slate-50 w-40 group-hover:border-slate-200 transition-all shadow-inner">
                                <i class="fa-solid ${ms.icon} text-cyan-600 w-5 text-center text-sm"></i>
                                <select onchange="handleMilestoneChange(${idx}, 'icon', this.value)" class="bg-transparent text-xs font-bold focus:outline-none w-full text-slate-600 cursor-pointer appearance-none">
                                    ${iconOptions.map(opt => `<option value="${opt.id}" ${ms.icon===opt.id?'selected':''}>${opt.label}</option>`).join('')}
                                </select>
                            </div>
                        </div>
                        <div class="shrink-0 flex items-end">
                            ${dateInputHtml}
                        </div>
                    </div>
                    <button onclick="removeMilestoneRow(${idx})" class="text-slate-300 hover:text-red-500 px-2 shrink-0 transition-all"><i class="fa-solid fa-trash-can text-lg"></i></button>
                `;
                container.appendChild(row);
            });
        }

        function validateDynamicMilestones() {
            document.querySelectorAll('.milestone-row input[type="date"]').forEach(el => {
                el.classList.remove('border-red-500', 'bg-red-50', 'ring-1', 'ring-red-500');
            });

            const d = (val) => val ? new Date(val).getTime() : null;
            let isValid = true;
            let lastDate = null;
            let errorIdx = -1;
            let errorMsg = "";

            for (let i = 0; i < editingMilestones.length; i++) {
                const ms = editingMilestones[i];
                let currentStartDate = null;
                let currentEndDate = null;

                if (ms.type === 'point' && ms.date) {
                    currentStartDate = currentEndDate = d(ms.date);
                } else if (ms.type === 'range') {
                    if (ms.startDate) currentStartDate = d(ms.startDate);
                    if (ms.endDate) currentEndDate = d(ms.endDate);
                    
                    if (currentStartDate && currentEndDate && currentStartDate > currentEndDate) {
                        isValid = false; errorIdx = i; errorMsg = `【${ms.name||'工程'}】開始日が終了日より後になっています。`;
                        break;
                    }
                }
                
                const isInspection = ms.name && ms.name.includes('客先立会');
                if (!isInspection) {
                    if (currentStartDate && lastDate && currentStartDate < lastDate) {
                        isValid = false; errorIdx = i; errorMsg = `上から順に時系列になるように設定してください。\n【${ms.name||'工程'}】の日付が前の工程より昔になっています。`;
                        break;
                    }

                    if (currentEndDate) lastDate = currentEndDate;
                    else if (currentStartDate) lastDate = currentStartDate;
                }
            }

            if (!isValid && errorIdx !== -1) {
                const row = document.querySelector(`.milestone-row[data-idx="${errorIdx}"]`);
                if (row) {
                    row.querySelectorAll('input[type="date"]').forEach(el => el.classList.add('border-red-500', 'bg-red-50', 'ring-1', 'ring-red-500'));
                }
                showDialog('工程設定エラー', errorMsg, 'error');
                return false;
            }
            return true;
        }

        async function saveProject() {
            const name = document.getElementById('project-name-input').value.trim();
            if (!name) { showDialog('エラー', '案件名を入力してください。', 'error'); return; }
            if (!validateDynamicMilestones()) return; 
            
            const cleanedMilestones = editingMilestones.filter(m => (m.type === 'point' ? m.date : (m.startDate || m.endDate)));

            if (editingProjectId) {
                const p = state.projects.find(x => x.id === editingProjectId);
                p.name = name; p.milestones = cleanedMilestones;
                if (!p.status) p.status = 'active';
                await saveDoc('projects', p.id, p);
            } else {
                const isTemplate = document.querySelector('input[name="proj_type"]:checked').value === 'template';
                const newProj = { 
                    id: generateId(), 
                    name, 
                    color: colorPalette[state.projects.length % colorPalette.length], 
                    milestones: cleanedMilestones,
                    status: 'active'
                };
                
                if (isTemplate) {
                    const selTempId = document.getElementById('proj-template-selector').value;
                    const tmpl = state.projectTemplates.find(pt => pt.id === selTempId);
                    if (tmpl) {
                        const taskDueDates = {}; 
                        for(const tt of tmpl.tasks) {
                            let dueDate = '';
                            if (tt.relDate) {
                                if (tt.relDate.base === 'milestone') {
                                    const ms = cleanedMilestones.find(m => m.name === tt.relDate.target) || 
                                               tmpl.milestones.find(m => m.name === tt.relDate.target);
                                    if (ms) {
                                        const baseDateStr = (ms.type === 'range' && tt.relDate.useStart) ? ms.startDate : (ms.type === 'range' ? ms.endDate : ms.date);
                                        if (baseDateStr) {
                                            dueDate = dateUtils.addBusinessDays(baseDateStr, tt.relDate.offset);
                                        }
                                    }
                                } else if (tt.relDate.base === 'task') {
                                    const baseDueDateStr = taskDueDates[tt.relDate.target];
                                    if (baseDueDateStr) {
                                        dueDate = dateUtils.addBusinessDays(baseDueDateStr, tt.relDate.offset);
                                    }
                                }
                            }
                            taskDueDates[tt.title] = dueDate;

                            const nt = {
                                id: generateId(), projectId: newProj.id, title: tt.title, status: 'todo', 
                                dueDate: dueDate, 
                                startDate: calculateStartDate(dueDate, tt.totalHours),
                                totalHours: tt.totalHours, notes: '',
                                subtasks: tt.subtasks.map(ts => ({ id: generateId(), title: ts.title, hours: ts.hours, progress: 0, completed: false, assignments: [], notes: ts.notes || '' }))
                            };
                            await saveDoc('tasks', nt.id, nt);
                        }
                        if(cleanedMilestones.length === 0) {
                            newProj.milestones = JSON.parse(JSON.stringify(tmpl.milestones));
                        }
                    }
                }
                await saveDoc('projects', newProj.id, newProj);
            }
            closeModal('project-modal');
        }

        function openTaskModal(taskId = null) {
            if (state.projects.length === 0) { showDialog('案内', 'まずは案件を登録してください。', 'warning'); return; }
            const isEdit = !!taskId;
            document.getElementById('task-modal-title').innerText = isEdit ? 'タスクの編集' : '新規タスクの作成';
            document.getElementById('task-template-selector-container').classList.toggle('hidden', isEdit);
            document.getElementById('btn-delete-task').classList.toggle('hidden', !isEdit);

            if (taskId) {
                workingTask = JSON.parse(JSON.stringify(state.tasks.find(t => t.id === taskId)));
            } else {
                const pId = document.getElementById('kanban-project-filter')?.value;
                const targetPId = (pId && pId !== 'all') ? pId : state.projects[0].id;
                workingTask = { id: generateId(), projectId: targetPId, title: '', status: 'todo', dueDate: '', startDate: '', totalHours: 0, notes: '', subtasks: [] };
            }
            renderTaskModalContent();
            showModal('task-modal');
        }

        function updateTaskTemplatesDropdown() {
            const sel = document.getElementById('task-template-selector');
            if(sel) sel.innerHTML = '<option value="">-- 選択 --</option>' + state.taskTemplates.map(t => `<option value="${t.id}">${t.title}</option>`).join('');
        }

        function loadTaskTemplate() {
            const tempId = document.getElementById('task-template-selector').value;
            if(!tempId) return;
            const t = state.taskTemplates.find(x => x.id === tempId);
            if(t) {
                workingTask.title = t.title; workingTask.totalHours = t.totalHours;
                workingTask.subtasks = t.subtasks.map(s => ({ ...s, id: generateId(), progress: 0, completed: false, assignments: [] }));
                recalculateDates(); renderTaskModalContent();
            }
            document.getElementById('task-template-selector').value = '';
        }

        async function saveAsTemplate() {
            if(!workingTask.title) { showDialog('エラー','タスク名を入力してください。', 'error'); return; }
            const temp = {
                id: generateId(), title: workingTask.title + ' (テンプレ)', totalHours: workingTask.totalHours,
                subtasks: workingTask.subtasks.map(s => ({ title: s.title, hours: s.hours, notes: s.notes || '' }))
            };
            await saveDoc('taskTemplates', temp.id, temp);
            showDialog('完了', '現在の内容をテンプレートとして保存しました。', 'info');
        }

        function deleteTaskTemplate() {
            const tempId = document.getElementById('task-template-selector').value;
            if(!tempId) { showDialog('エラー', '削除するテンプレートを選択してください。', 'warning'); return; }
            showDialog('確認', '選択したテンプレートを削除しますか？', 'warning', async () => {
                await deleteDocById('taskTemplates', tempId);
            }, () => {});
        }

        function deleteCurrentTask() {
            if(!workingTask || !workingTask.id) return;
            showDialog('確認', 'このタスクを削除しますか？\nこの操作は元に戻せません。', 'warning', async () => {
                await deleteDocById('tasks', workingTask.id);
                state.selectedTasks.delete(workingTask.id);
                closeModal('task-modal');
            }, () => {});
        }

        function renderTaskModalContent() {
            const body = document.getElementById('task-modal-body');
            let projOpts = state.projects.map(p => `<option value="${p.id}" ${workingTask.projectId === p.id ? 'selected' : ''}>${p.name}</option>`).join('');
            let stHtml = workingTask.subtasks.map(st => `
                <div class="mb-4 p-4 bg-slate-50 border border-slate-200 rounded-xl shadow-sm transition-all hover:border-cyan-400">
                    <div class="flex flex-wrap items-center gap-4">
                        <div class="flex items-center gap-2">
                            <input type="checkbox" ${st.completed ? 'checked' : ''} onchange="handleSubtaskChange('${st.id}', 'checked', this.checked)" class="w-6 h-6 bg-white border-slate-300 text-cyan-600 rounded cursor-pointer focus:ring-cyan-500">
                        </div>
                        <div class="flex-1 min-w-[200px]">
                            <input type="text" value="${st.title}" onchange="handleSubtaskChange('${st.id}', 'title', this.value)" placeholder="小タスク名（例：基本設計、図面チェック）" class="w-full text-sm font-bold border-b-2 border-slate-100 hover:border-slate-300 focus:border-cyan-500 rounded-none px-2 py-1 bg-transparent text-slate-800 transition-all">
                        </div>
                        <div class="flex items-center gap-4">
                            <div class="flex items-center gap-2">
                                <span class="text-[10px] font-black text-slate-500">進捗</span>
                                <input type="number" min="0" max="100" value="${st.progress || 0}" onchange="handleSubtaskChange('${st.id}', 'progress', this.value)" class="w-16 text-sm font-bold bg-white border-2 border-slate-200 rounded-lg px-2 py-1 text-right text-cyan-600 focus:border-cyan-500 outline-none">
                                <span class="text-[10px] text-slate-400 font-bold">%</span>
                            </div>
                            <div class="flex items-center gap-2">
                                <span class="text-[10px] font-black text-slate-500">工数</span>
                                <input type="number" min="0" step="0.5" value="${st.hours}" onchange="handleSubtaskChange('${st.id}', 'hours', this.value)" class="w-16 text-sm font-bold bg-white border-2 border-slate-200 rounded-lg px-2 py-1 text-right text-slate-700 focus:border-cyan-500 outline-none" placeholder="0.0">
                                <span class="text-[10px] text-slate-400 font-bold">h</span>
                            </div>
                            <button onclick="toggleSubtaskNote('st-note-${st.id}', 'st-note-icon-${st.id}')" class="text-slate-400 hover:text-cyan-600 p-2 transition-colors" title="メモを表示">
                                <i id="st-note-icon-${st.id}" class="fa-solid ${st.notes ? 'fa-comment-dots text-cyan-500' : 'fa-comment-dots'} text-xl"></i>
                            </button>
                            <button onclick="removeSubtask('${st.id}')" class="text-slate-300 hover:text-red-500 px-2 transition-all"><i class="fa-solid fa-trash-can text-lg"></i></button>
                        </div>
                    </div>
                    <div id="st-note-${st.id}" class="mt-4 pl-9 ${st.notes ? '' : 'hidden'}">
                        <textarea onchange="handleSubtaskChange('${st.id}', 'notes', this.value)" rows="2" class="w-full bg-slate-100 border-2 border-slate-200 rounded-xl px-4 py-3 text-sm font-medium text-slate-600 focus:border-cyan-500 outline-none transition-all" placeholder="詳細な進捗状況やメモを入力してください...">${st.notes || ''}</textarea>
                    </div>
                </div>
            `).join('');
            
            if(!stHtml) stHtml = `
                <div class="text-center py-12 border-2 border-dashed border-slate-200 rounded-2xl bg-slate-50">
                    <p class="text-sm font-bold text-slate-400">小タスクが登録されていません</p>
                    <button onclick="addSubtask()" class="mt-4 px-6 py-2.5 bg-cyan-600 text-white rounded-xl text-xs font-bold hover:bg-cyan-700 shadow-md transition-all">小タスクを追加する</button>
                </div>`;

            body.innerHTML = `
                <div class="space-y-12">
                    <!-- 基本情報セクション -->
                    <div class="bg-slate-50 p-8 rounded-3xl border-2 border-slate-100">
                        <h3 class="text-xs font-black text-cyan-700 uppercase tracking-[0.2em] mb-6 flex items-center gap-2">
                            <i class="fa-solid fa-circle-info"></i> 基本設定
                        </h3>
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-10">
                            <div class="space-y-6">
                                <div>
                                    <label class="block text-xs font-black text-slate-500 mb-2">所属案件</label>
                                    <div class="relative">
                                        <select onchange="updateWorkingTask('projectId', this.value)" class="w-full bg-white border-2 border-slate-200 rounded-xl px-4 py-3 text-sm font-bold text-slate-700 focus:border-cyan-500 outline-none cursor-pointer appearance-none shadow-sm">
                                            ${projOpts}
                                        </select>
                                        <div class="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400"><i class="fa-solid fa-chevron-down text-xs"></i></div>
                                    </div>
                                </div>
                                <div>
                                    <label class="block text-xs font-black text-slate-500 mb-2">現在のステータス</label>
                                    <div class="flex gap-2">
                                        ${['todo', 'in_progress', 'done'].map(s => {
                                            const label = s === 'todo' ? '未着手' : s === 'in_progress' ? '進行中' : '完了';
                                            const active = workingTask.status === s;
                                            const activeClass = s === 'todo' ? 'bg-slate-200 text-slate-600 border-slate-300' : 
                                                              s === 'in_progress' ? 'bg-cyan-100 text-cyan-700 border-cyan-300 shadow-sm' : 
                                                              'bg-green-100 text-green-700 border-green-300 shadow-sm';
                                            return `<button onclick="updateWorkingTask('status', '${s}')" class="flex-1 py-3 px-2 rounded-xl border-2 text-xs font-black transition-all ${active ? activeClass : 'bg-white border-slate-100 text-slate-300 hover:border-slate-300 hover:text-slate-500'}">${label}</button>`;
                                        }).join('')}
                                    </div>
                                </div>
                            </div>
                            <div class="space-y-6">
                                <div>
                                    <label class="block text-xs font-black text-slate-500 mb-2">タスク名</label>
                                    <input type="text" value="${workingTask.title}" onchange="updateWorkingTask('title', this.value)" placeholder="例：制御盤の設計" class="w-full bg-white border-2 border-slate-200 rounded-xl px-4 py-3 text-sm font-bold text-slate-800 focus:border-cyan-500 outline-none shadow-sm transition-all">
                                </div>
                                <div>
                                    <label class="block text-xs font-black text-slate-500 mb-2">完了納期</label>
                                    <input type="date" value="${workingTask.dueDate}" onchange="updateWorkingTask('dueDate', this.value)" class="w-full bg-white border-2 border-slate-200 rounded-xl px-4 py-3 text-sm font-bold text-slate-800 focus:border-cyan-500 outline-none shadow-sm">
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- 小タスク管理セクション -->
                    <div class="grid grid-cols-1 lg:grid-cols-12 gap-10">
                        <div class="lg:col-span-7 space-y-6">
                            <div class="flex justify-between items-center px-2">
                                <h3 class="text-xs font-black text-slate-800 uppercase tracking-widest flex items-center gap-2">
                                    <i class="fa-solid fa-list-check text-cyan-600"></i> 小タスク（作業内容）
                                </h3>
                                <button onclick="addSubtask()" class="px-5 py-2 bg-slate-800 text-white rounded-xl text-xs font-bold hover:bg-slate-900 transition-all shadow-md">
                                    <i class="fa-solid fa-plus mr-1.5"></i> 追加する
                                </button>
                            </div>
                            <div class="max-h-[500px] overflow-y-auto pr-2 custom-scrollbar">
                                ${stHtml}
                            </div>
                        </div>

                        <!-- サマリー・メモ セクション -->
                        <div class="lg:col-span-5 space-y-8">
                            <div class="bg-white p-8 border-2 border-slate-100 rounded-3xl shadow-sm space-y-8">
                                <div class="flex justify-between items-center border-b-2 border-slate-50 pb-6">
                                    <span class="text-xs font-black text-slate-400 uppercase tracking-widest">集計結果</span>
                                    <div class="text-right">
                                        <div class="text-[10px] text-slate-400 font-bold mb-1">合計工数</div>
                                        <div class="text-3xl font-black text-slate-800">${workingTask.totalHours}<span class="text-sm ml-1 text-slate-400">h</span></div>
                                    </div>
                                </div>

                                <div class="space-y-6">
                                    <div>
                                        <label class="block text-xs font-black text-slate-500 mb-3">自動計算による着手予定日</label>
                                        <div class="bg-slate-50 border-2 border-slate-100 rounded-2xl px-5 py-4 text-base font-black text-cyan-700 flex items-center gap-4">
                                            <i class="fa-regular fa-calendar-check text-xl"></i>
                                            ${workingTask.startDate ? workingTask.startDate.replace(/-/g, '/') : '未設定'}
                                        </div>
                                        <p class="text-[10px] text-slate-400 mt-3 leading-relaxed font-bold italic">※納期から工数を逆算し、他の案件負荷や休日を考慮して算出されます。</p>
                                    </div>
                                    <div class="pt-4 border-t-2 border-slate-50">
                                        <label class="block text-xs font-black text-slate-500 mb-3">補足事項・メモ</label>
                                        <textarea onchange="updateWorkingTask('notes', this.value)" rows="6" class="w-full bg-slate-50 border-2 border-slate-100 rounded-2xl px-5 py-4 text-sm font-medium text-slate-600 focus:border-cyan-500 outline-none transition-all resize-none" placeholder="タスクに関する詳細な指示や連絡事項を入力...">${workingTask.notes || ''}</textarea>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }

        function updateWorkingTask(f, v) { workingTask[f] = v; if (f === 'dueDate') { recalculateDates(); renderTaskModalContent(); } }
        function addSubtask() { workingTask.subtasks.push({ id: generateId(), title: '', hours: 0, progress: 0, completed: false, assignments: [], notes: '' }); recalculateDates(); renderTaskModalContent(); }
        function removeSubtask(id) { workingTask.subtasks = workingTask.subtasks.filter(s => s.id !== id); recalculateDates(); renderTaskModalContent(); }
        function handleSubtaskChange(id, field, value) {
            const st = workingTask.subtasks.find(s => s.id === id); if(!st) return;
            if(field === 'hours') { st.hours = parseFloat(value) || 0; recalculateDates(); renderTaskModalContent(); }
            else if(field === 'progress') {
                let p = parseInt(value) || 0; p = p > 100 ? 100 : (p < 0 ? 0 : p);
                st.progress = p; st.completed = (p === 100);
                checkSubtaskStatusRules(); renderTaskModalContent();
            }
            else if(field === 'checked') {
                st.completed = value; st.progress = value ? 100 : 0;
                checkSubtaskStatusRules(); renderTaskModalContent();
            }
            else { st[field] = value; }
        }

        function adjustToBusinessDay(dateStr, direction = -1) {
            if (!dateStr) return "";
            let d = new Date(dateStr);
            while (!isBusinessDay(d)) {
                d.setDate(d.getDate() + direction);
            }
            return dateUtils.formatDate(d);
        }

        function recalculateDates() {
            if (workingTask.dueDate) {
                workingTask.dueDate = adjustToBusinessDay(workingTask.dueDate, -1);
            }
            workingTask.totalHours = workingTask.subtasks.reduce((sum, st) => sum + (st.hours || 0), 0);
            workingTask.startDate = calculateStartDate(workingTask.dueDate, workingTask.totalHours, workingTask.id);
        }

        function checkSubtaskStatusRules() {
            const allChecked = workingTask.subtasks.length > 0 && workingTask.subtasks.every(s => s.completed);
            const anyChecked = workingTask.subtasks.some(s => s.completed || s.progress > 0);
            if (allChecked && workingTask.status !== 'done') {
                showDialog('確認', 'すべて完了しました。ステータスを「完了」にしますか？', 'info', () => { workingTask.status = 'done'; renderTaskModalContent(); });
            } else if (anyChecked && workingTask.status === 'todo') {
                workingTask.status = 'in_progress';
            }
        }

        async function saveTask() {
            if (!workingTask.title.trim()) { showDialog('エラー', 'タスク名を入力してください。', 'error'); return; }
            if (workingTask.status === 'done' && (workingTask.subtasks.length === 0 || !workingTask.subtasks.every(s => s.completed))) {
                 showDialog('エラー', 'すべての小タスクを完了させないと保存できません。', 'error'); return;
            }
            
            // Adjust due date if it's a holiday
            if (workingTask.dueDate) {
                const adjusted = adjustToBusinessDay(workingTask.dueDate, -1);
                if (adjusted !== workingTask.dueDate) {
                    workingTask.dueDate = adjusted;
                    recalculateDates();
                }
            }

            await saveDoc('tasks', workingTask.id, workingTask);
            closeModal('task-modal');
        }

        function toggleTaskSelection(id, isChecked) {
            if(isChecked) state.selectedTasks.add(id); else state.selectedTasks.delete(id);
            document.getElementById('selected-count-dup').innerText = state.selectedTasks.size;
            document.getElementById('selected-count-del').innerText = state.selectedTasks.size;
        }

        async function duplicateSelectedTasks() {
            if (state.selectedTasks.size === 0) { showDialog('案内', '複製するタスクをチェックボックスで選択してください。', 'warning'); return; }
            let count = 0;
            for (const id of state.selectedTasks) {
                const org = state.tasks.find(t => t.id === id);
                if (org) {
                    const dup = JSON.parse(JSON.stringify(org));
                    dup.id = generateId();
                    dup.title = dup.title + ' (コピー)';
                    dup.status = 'todo';
                    dup.subtasks.forEach(s => { s.id = generateId(); s.completed = false; s.progress = 0; s.assignments = []; });
                    await saveDoc('tasks', dup.id, dup);
                    count++;
                }
            }
            state.selectedTasks.clear();
            document.getElementById('selected-count-dup').innerText = '0';
            document.getElementById('selected-count-del').innerText = '0';
            showDialog('完了', `${count}件のタスクを複製しました。`, 'info');
        }

        async function deleteSelectedTasks() {
            if (state.selectedTasks.size === 0) { showDialog('案内', '削除するタスクをチェックボックスで選択してください。', 'warning'); return; }
            showDialog('確認', `${state.selectedTasks.size}件のタスクを削除しますか？\nこの操作は元に戻せません。`, 'warning', async () => {
                for (const id of state.selectedTasks) {
                    await deleteDocById('tasks', id);
                }
                state.selectedTasks.clear();
                document.getElementById('selected-count-dup').innerText = '0';
                document.getElementById('selected-count-del').innerText = '0';
            }, () => {});
        }

        function renderKanban() {
            const container = document.getElementById('kanban-board');
            container.innerHTML = '';
            const hideDone = document.getElementById('kanban-hide-done')?.checked || false;
            const pId = document.getElementById('kanban-project-filter')?.value || 'all';

            let filterTasks = state.tasks;
            
            if (!state.showCompletedProjects) {
                filterTasks = filterTasks.filter(t => !isProjectCompleted(t.projectId));
            }

            if (pId !== 'all') {
                filterTasks = filterTasks.filter(t => t.projectId === pId);
            } else if (state.kanbanSelectedProjects.size > 0) {
                filterTasks = filterTasks.filter(t => state.kanbanSelectedProjects.has(t.projectId));
            }

            const columns = [
                { id: 'todo', title: '未着手', icon: 'fa-list-ul', color: 'slate' },
                { id: 'in_progress', title: '進行中', icon: 'fa-spinner', color: 'cyan' },
                { id: 'done', title: '完了', icon: 'fa-check-circle', color: 'fuchsia' }
            ];

            columns.forEach(col => {
                let colTasks = filterTasks.filter(t => t.status === col.id);
                if (hideDone && col.id === 'done') colTasks = []; 

                colTasks.sort((a, b) => {
                    const da = a.dueDate ? a.dueDate : '9999-12-31';
                    const db = b.dueDate ? b.dueDate : '9999-12-31';
                    return da.localeCompare(db);
                });

                const colDiv = document.createElement('div');
                colDiv.className = `flex flex-col bg-slate-200/50 rounded-2xl w-[400px] flex-shrink-0 max-h-full border-2 border-slate-200/60 shadow-inner`;
                
                const titleColorClass = col.id === 'in_progress' ? 'text-cyan-700' : (col.id === 'done' ? 'text-fuchsia-700' : 'text-slate-500');
                const borderTopClass = col.id === 'in_progress' ? 'border-t-4 border-cyan-500' : (col.id === 'done' ? 'border-t-4 border-fuchsia-500' : '');

                colDiv.innerHTML = `
                    <div class="p-5 border-b-2 border-slate-200 flex justify-between items-center bg-white/80 rounded-t-2xl ${borderTopClass}">
                        <div class="flex items-center gap-3"><i class="fa-solid ${col.icon} ${titleColorClass} text-lg"></i><h3 class="font-black ${titleColorClass} text-sm font-mono tracking-widest uppercase">${col.title}</h3></div>
                        <span class="bg-slate-800 text-white text-xs font-mono font-black px-3 py-1 rounded-full shadow-md">${colTasks.length}</span>
                    </div>
                    <div class="p-4 flex-1 overflow-y-auto space-y-5 drop-zone" ondragover="allowDrop(event)" ondragleave="dragLeave(event)" ondrop="dropTask(event, '${col.id}')"></div>
                `;
                const taskContainer = colDiv.querySelector('.drop-zone');
                
                colTasks.forEach(task => {
                    const project = state.projects.find(p => p.id === task.projectId);
                    const pColor = project ? project.color : '#9ca3af';
                    const compSub = task.subtasks.filter(s => s.completed).length;
                    
                    const isComp = isProjectCompleted(task.projectId);
                    const overdue = isOverdue(task);
                    const delayed = isDelayed(task);
                    const isSelected = state.selectedTasks.has(task.id);

                    const borderClass = overdue ? 'border-fuchsia-500 shadow-[0_0_15px_rgba(217,70,239,0.2)]' : (delayed ? 'border-amber-500' : (isSelected ? 'border-cyan-500 shadow-[0_0_15px_rgba(14,165,233,0.2)]' : 'border-slate-200'));
                    const opacityClass = isComp ? 'opacity-50 grayscale-[0.5]' : '';

                    const card = document.createElement('div');
                    card.className = `task-card bg-white p-6 rounded-xl border-2 ${borderClass} ${opacityClass} hover:border-cyan-400 transition-all relative overflow-hidden group shadow-sm hover:shadow-md`;
                    card.draggable = true;
                    card.ondragstart = (e) => dragStart(e, task.id);
                    card.ondblclick = () => openTaskModal(task.id);
                    
                    let alertBadge = '';
                    if (isComp) {
                        alertBadge = `<div class="text-slate-500 text-[10px] font-mono font-black mb-3 bg-slate-100 px-2 py-1 rounded border border-slate-200 inline-block uppercase tracking-tighter"><i class="fa-solid fa-box-archive mr-1"></i>アーカイブ済</div>`;
                    } else if (overdue) {
                        alertBadge = `<div class="text-fuchsia-600 text-[10px] font-mono font-black mb-3 bg-fuchsia-50 px-2 py-1 rounded border border-fuchsia-200 inline-block uppercase tracking-tighter"><i class="fa-solid fa-triangle-exclamation mr-1"></i>納期遅れ</div>`;
                    } else if (delayed) {
                        alertBadge = `<div class="text-amber-600 text-[10px] font-mono font-black mb-3 bg-amber-50 px-2 py-1 rounded border border-amber-200 inline-block uppercase tracking-tighter"><i class="fa-solid fa-triangle-exclamation mr-1"></i>着手遅れ</div>`;
                    }

                    const dateColor = overdue ? 'text-fuchsia-600' : (delayed ? 'text-amber-600' : 'text-slate-400');
                    const titleColor = overdue ? 'text-fuchsia-700' : 'text-slate-800';

                    card.innerHTML = `
                        <div class="absolute left-0 top-0 bottom-0 w-1.5" style="background-color: ${pColor}"></div>
                        <input type="checkbox" class="absolute top-5 right-5 w-5 h-5 cursor-pointer bg-white border-2 border-slate-200 text-cyan-500 rounded focus:ring-cyan-500 z-10" 
                               onclick="event.stopPropagation(); toggleTaskSelection('${task.id}', this.checked)" ${isSelected ? 'checked' : ''}>
                        
                        <div class="flex justify-between items-start mb-3 pl-4 pr-10">
                            <span class="text-[10px] font-mono font-black px-2 py-1 rounded border border-slate-100 bg-slate-50 text-slate-500 truncate max-w-full uppercase tracking-tighter">${project ? project.name : '所属なし'}</span>
                        </div>
                        <div class="pl-4">
                            ${alertBadge}
                            <h4 class="font-black ${titleColor} text-base mb-2 pr-6 leading-snug tracking-tight uppercase">${task.title}</h4>
                            <div class="text-xs text-slate-400 line-clamp-2 mb-4 min-h-[2rem] font-mono font-bold leading-relaxed">${task.notes || ''}</div>
                            <div class="flex items-center justify-between mt-auto pt-3 border-t border-slate-50">
                                <div class="flex items-center gap-2 text-xs font-mono font-black text-cyan-600" title="Progress">
                                    <i class="fa-solid fa-microchip"></i>
                                    <span>${compSub}/${task.subtasks.length} (${Math.round(task.subtasks.reduce((sum, s) => sum + ((s.progress||0) * (s.hours||0)), 0) / (task.totalHours || 1))}%)</span>
                                </div>
                                <div class="flex items-center gap-2 text-xs font-mono font-black ${dateColor}"><i class="fa-regular fa-clock"></i><span>${task.dueDate ? task.dueDate.substring(5).replace('-','.') : '---'}</span></div>
                            </div>
                        </div>
                        <div class="absolute bottom-0 left-0 right-0 bg-cyan-600 text-[10px] font-mono font-black text-center py-1 text-white opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none uppercase tracking-widest">Execute_Command</div>
                    `;
                    taskContainer.appendChild(card);
                });
                container.appendChild(colDiv);
            });
        }

        let draggedTaskId = null;
        function dragStart(ev, taskId) { draggedTaskId = taskId; ev.dataTransfer.setData("text/plain", taskId); setTimeout(() => ev.target.classList.add('opacity-50'), 0); }
        function allowDrop(ev) { ev.preventDefault(); ev.target.closest('.drop-zone')?.classList.add('drag-over'); }
        function dragLeave(ev) { ev.target.closest('.drop-zone')?.classList.remove('drag-over'); }
        async function dropTask(ev, targetStatus) {
            ev.preventDefault(); ev.target.closest('.drop-zone')?.classList.remove('drag-over');
            if(!draggedTaskId) return;
            const task = state.tasks.find(t => t.id === draggedTaskId);
            if (targetStatus === 'done' && (task.subtasks.length === 0 || !task.subtasks.every(s => s.completed))) {
                showDialog('エラー', '小タスクが設定されていない、または全て100%完了していません。', 'error');
                return;
            }
            task.status = targetStatus;
            draggedTaskId = null;
            await saveDoc('tasks', task.id, task);
        }

        function toggleGanttTask(taskId) { state.expandedGanttTasks.has(taskId) ? state.expandedGanttTasks.delete(taskId) : state.expandedGanttTasks.add(taskId); renderGantt(); }

        function generateGanttHTML(startDate, endDate, projects, tasksToRender, cellWidth = 48, headerWidth = 380) {
            const isPrint = document.body.classList.contains('print-gantt');
            const currentHeaderWidth = isPrint ? (headerWidth || 250) : headerWidth;
            const currentCellWidth = cellWidth;

            const dates = dateUtils.getDatesBetween(startDate, endDate);
            const totalDays = dates.length;
            const today = new Date(); today.setHours(0,0,0,0);

            const dailyHours = new Array(totalDays).fill(0);
            projects.forEach(proj => {
                const pTasks = tasksToRender.filter(t => t.projectId === proj.id);
                pTasks.forEach(task => {
                    if (task.startDate && task.dueDate && task.totalHours > 0) {
                        const ts = new Date(task.startDate).setHours(0,0,0,0);
                        const te = new Date(task.dueDate).setHours(0,0,0,0);
                        let bDays = 0;
                        for(let t=ts; t<=te; t+=86400000) { if(isBusinessDay(new Date(t))) bDays++; }
                        if(bDays > 0) {
                            const progSum = task.subtasks.reduce((sum, s) => sum + ((s.progress||0) * (s.hours||0)), 0);
                            const totalH = task.totalHours || 1;
                            const progressPercent = task.status === 'done' ? 100 : Math.round(progSum / totalH);
                            const remainingHours = task.status === 'done' ? 0 : task.totalHours * (1 - (progressPercent / 100));
                            const hoursPerDay = remainingHours / bDays;
                            
                            dates.forEach((d, i) => {
                                const time = d.getTime();
                                if(time >= ts && time <= te && isBusinessDay(d)) dailyHours[i] += hoursPerDay;
                            });
                        }
                    }
                });
            });

            const weeks = [];
            let currentWeek = null;
            dates.forEach((d, i) => {
                const isMonday = d.getDay() === 1;
                if (!currentWeek || isMonday || i === 0) {
                    currentWeek = { 
                        label: `${d.getMonth()+1}/${d.getDate()}~`, 
                        span: 0, 
                        hours: 0, 
                        start: dateUtils.formatDate(d),
                        end: ''
                    };
                    weeks.push(currentWeek);
                }
                currentWeek.span++;
                currentWeek.hours += dailyHours[i];
                currentWeek.end = dateUtils.formatDate(d);
            });

            const stickyClass = isPrint ? "" : "sticky left-0 z-50 shadow-[4px_0_10px_rgba(0,0,0,0.05)]";
            const headerStickyClass = isPrint ? "" : "sticky top-0 z-40";

            const pbClass = isPrint ? 'pb-2' : 'pb-12';
            const headerBg = 'bg-white';

            let html = `<div class="min-w-max bg-white relative ${pbClass}" style="width: max-content;">`;
            
            // Header Grid
            html += `<div style="display: grid; grid-template-columns: ${currentHeaderWidth}px repeat(${totalDays}, ${currentCellWidth}px);" class="border-b-2 border-slate-200 ${headerStickyClass} ${headerBg} shadow-sm">
                        <div class="border-r-2 border-slate-200 bg-slate-50 flex items-center p-4 row-span-3 ${stickyClass} w-full h-full border-b-2 border-b-slate-200">
                            <span class="font-black text-cyan-800 text-xs font-mono uppercase tracking-[0.2em]">System_Timeline / Project_Map</span>
                        </div>`;
            
            // Row 1: Months
            let curMonth = -1; let mSpan = 0;
            dates.forEach((d, i) => {
                if(d.getMonth() !== curMonth) {
                    if(mSpan>0) html += `<div style="grid-column: span ${mSpan};" class="border-r border-slate-200 bg-slate-100 text-center text-xs py-1.5 font-mono font-black text-slate-500 uppercase tracking-widest border-b border-slate-200">${dates[i-1].getMonth()+1}_Month</div>`;
                    curMonth = d.getMonth(); mSpan = 1;
                } else { mSpan++; }
                if(i === dates.length-1) html += `<div style="grid-column: span ${mSpan};" class="border-r border-slate-200 bg-slate-100 text-center text-xs py-1.5 font-mono font-black text-slate-500 uppercase tracking-widest border-b border-slate-200">${d.getMonth()+1}_Month</div>`;
            });

            // Row 2: Weekly Workload
            weeks.forEach(w => {
                let alertClass = 'bg-slate-50 text-slate-400';
                let icon = '';
                
                if (w.hours > 30) {
                    alertClass = 'bg-fuchsia-50 text-fuchsia-600 border-x-2 border-fuchsia-100';
                    icon = `<i class="fa-solid fa-fire text-fuchsia-500 mr-1.5"></i>`;
                } else if (w.hours > 20) {
                    alertClass = 'bg-amber-50 text-amber-600 border-x-2 border-amber-100';
                    icon = `<i class="fa-solid fa-triangle-exclamation text-amber-500 mr-1.5"></i>`;
                }

                html += `<div onclick="filterGanttByWeek('${w.start}', '${w.end}')" style="grid-column: span ${w.span};" class="border-r border-b border-slate-200 ${alertClass} text-center text-[11px] font-mono py-2 font-black flex items-center justify-center overflow-hidden cursor-pointer hover:bg-white hover:text-cyan-600 transition-all">
                            ${icon} ${w.span >= 3 ? w.label : ''} <span class="ml-1.5 px-2 bg-white/60 rounded border border-slate-200 shadow-sm">${parseFloat(w.hours.toFixed(1))}h</span>
                         </div>`;
            });

            // Row 3: Days
            dates.forEach(d => {
                const isHol = !isBusinessDay(d); const isToday = d.toDateString() === today.toDateString();
                const bg = isToday ? 'bg-cyan-500/10' : (isHol ? 'bg-slate-50' : 'bg-transparent');
                const txt = isToday ? 'text-cyan-700 font-black' : (d.getDay()===0?'text-fuchsia-500':d.getDay()===6?'text-cyan-600':(isHol?'text-slate-300':'text-slate-500'));
                html += `<div class="border-r border-slate-200 text-center text-[11px] font-mono py-1.5 ${bg} ${txt}">${d.getDate()}</div>`;
            });
            html += `</div>`;

            // Background Grid
            const headerHeight = isPrint ? 80 : 96;
            html += `<div class="absolute top-[${headerHeight}px] bottom-0 left-0 right-0 pointer-events-none z-0" style="display: grid; grid-template-columns: ${currentHeaderWidth}px repeat(${totalDays}, ${currentCellWidth}px);">`;
            html += `<div class="border-r-2 border-slate-200 h-full"></div>`;
            let todayOffsetLeft = 0;
            dates.forEach((d, i) => {
                const isHol = !isBusinessDay(d);
                if (d.toDateString() === today.toDateString()) todayOffsetLeft = currentHeaderWidth + (i * currentCellWidth) + (currentCellWidth / 2);
                html += `<div class="border-r border-slate-100 h-full ${isHol ? 'holiday-bg' : ''}"></div>`;
            });
            if (todayOffsetLeft > 0) html += `<div class="absolute inset-y-0 w-1 bg-cyan-500 shadow-[0_0_15px_#0ea5e9] z-20 opacity-60" style="left: ${todayOffsetLeft-2}px;"></div>`;
            html += `</div>`;

            html += `<div class="relative z-10">`;
            
            projects.forEach((proj, pIndex) => {
                const pTasks = tasksToRender.filter(t => t.projectId === proj.id).sort((a,b)=> new Date(a.startDate||'2099') - new Date(b.startDate||'2099'));
                const isComp = isProjectCompleted(proj.id);
                const projOpacity = isComp ? 'opacity-40 grayscale-[0.8]' : '';

                if (pIndex > 0) {
                    html += `
                    <div class="flex h-6 border-b border-slate-100">
                        <div style="width: ${currentHeaderWidth}px; min-width: ${currentHeaderWidth}px;" class="border-r-2 border-slate-200 bg-slate-50/40 ${stickyClass}"></div>
                        <div class="flex-1"></div>
                    </div>`;
                }

                html += `
                <div class="flex border-y-2 border-slate-200 bg-slate-100/50 backdrop-blur-sm shadow-sm ${projOpacity}">
                    <div style="width: ${currentHeaderWidth}px; min-width: ${currentHeaderWidth}px;" class="p-4 border-r-2 border-slate-200 ${stickyClass} flex items-center bg-slate-50/80 font-black text-slate-800 text-sm font-mono uppercase tracking-tight italic">
                        <div class="w-4 h-4 rounded-sm mr-3 shadow-md" style="background-color: ${proj.color}"></div>
                        <span class="truncate">${proj.name}${isComp ? ' [完了]' : ''}</span>
                    </div>
                    <div class="relative flex-1 py-4" style="width: ${totalDays * currentCellWidth}px; height: 56px;">
                `;
                
                if(proj.milestones && proj.milestones.length > 0) {
                    proj.milestones.forEach(ms => {
                        const iconClass = ms.icon || 'fa-flag';
                        const colorClass = ms.color || '#4b5563';
                        
                        if (ms.type === 'point' && ms.date) {
                            const t = new Date(ms.date).setHours(0,0,0,0);
                            if(t >= startDate.getTime() && t <= endDate.getTime()) {
                                const offset = (t - startDate.getTime()) / (1000*60*60*24);
                                const left = offset * currentCellWidth + (currentCellWidth/2);
                                html += `<div class="absolute top-1/2 -translate-y-1/2 flex flex-col items-center group cursor-help z-20" style="left: ${left}px;">
                                            <i class="fa-solid ${iconClass} text-sm filter drop-shadow-sm transition-all group-hover:scale-125" style="color:${colorClass}"></i>
                                            <span class="absolute top-full mt-2 bg-slate-800 border border-slate-700 text-white text-[10px] font-mono font-bold px-3 py-1 rounded shadow-xl opacity-0 group-hover:opacity-100 whitespace-nowrap z-50 uppercase tracking-widest transition-all">${ms.name}</span>
                                         </div>`;
                            }
                        } else if (ms.type === 'range' && ms.startDate && ms.endDate) {
                            const ts = new Date(ms.startDate).setHours(0,0,0,0); const te = new Date(ms.endDate).setHours(0,0,0,0);
                            if(te >= startDate.getTime() && ts <= endDate.getTime()) {
                                const os = Math.max(0, (ts - startDate.getTime()) / (1000*60*60*24));
                                const oe = Math.min(totalDays-1, (te - startDate.getTime()) / (1000*60*60*24));
                                const left = os * currentCellWidth; const w = (oe - os + 1) * currentCellWidth;
                                
                                html += `<div class="absolute top-1/2 -translate-y-1/2 h-2.5 rounded-full opacity-30 border-2 border-white group z-10 flex items-center" style="left: ${left}px; width: ${w}px; background-image: repeating-linear-gradient(45deg, transparent, transparent 6px, rgba(255,255,255,0.2) 6px, rgba(255,255,255,0.2) 12px); background-color: ${colorClass}; shadow: inset 0 2px 4px rgba(0,0,0,0.1);">
                                            <span class="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 bg-slate-800 border border-slate-700 text-white text-[10px] font-mono font-bold px-3 py-1 rounded shadow-xl opacity-0 group-hover:opacity-100 whitespace-nowrap z-50 uppercase tracking-widest transition-all">${ms.name}</span>
                                         </div>`;
                            }
                        }
                    });
                }
                html += `</div></div>`;

                pTasks.forEach(task => {
                    const isExp = state.expandedGanttTasks.has(task.id);
                    const overdue = isOverdue(task);
                    const delayed = isDelayed(task);
                    
                    let alertIcon = '';
                    if (overdue) alertIcon = `<i class="fa-solid fa-triangle-exclamation text-fuchsia-600 text-xs"></i>`;
                    else if (delayed) alertIcon = `<i class="fa-solid fa-triangle-exclamation text-amber-600 text-xs"></i>`;

                    const titleClass = overdue ? 'text-fuchsia-700 font-black' : (delayed ? 'text-amber-700 font-black' : 'text-slate-600 font-bold');

                    html += `
                    <div class="flex border-b border-slate-100 hover:bg-slate-50 transition-colors group">
                        <div style="width: ${currentHeaderWidth}px; min-width: ${currentHeaderWidth}px;" class="py-2.5 pl-8 pr-4 border-r-2 border-slate-200 bg-white ${stickyClass} flex items-center justify-between group-hover:bg-slate-50">
                            <div class="flex items-center gap-3 overflow-hidden w-full cursor-pointer" onclick="toggleGanttTask('${task.id}')">
                                <i class="fa-solid ${task.subtasks.length > 0 ? (isExp ? 'fa-chevron-down' : 'fa-chevron-right') : 'fa-minus text-[8px]'} text-slate-400 w-5 text-sm"></i>
                                ${alertIcon}
                                <div class="truncate flex-1 text-[13px] font-mono uppercase tracking-tight ${titleClass}" title="${task.title}">${task.title}</div>
                            </div>
                            <div class="text-[11px] font-mono font-black text-slate-400 w-10 text-right flex-shrink-0">${task.totalHours}h</div>
                        </div>
                        <div class="relative flex-1 py-2.5" style="width: ${totalDays * currentCellWidth}px;">
                    `;

                    if (task.startDate && task.dueDate) {
                        const ts = new Date(task.startDate).setHours(0,0,0,0); const te = new Date(task.dueDate).setHours(0,0,0,0);
                        if (te >= startDate.getTime() && ts <= endDate.getTime()) {
                            const os = Math.max(0, (ts - startDate.getTime()) / (1000*60*60*24));
                            const oe = Math.min(totalDays - 1, (te - startDate.getTime()) / (1000*60*60*24));
                            const left = os * currentCellWidth; const w = (oe - os + 1) * currentCellWidth;
                            
                            const progSum = task.subtasks.reduce((sum, s) => sum + ((s.progress||0) * (s.hours||0)), 0);
                            const totalH = task.totalHours || 1;
                            const progressPercent = task.status === 'done' ? 100 : Math.round(progSum / totalH);
                            
                            const barColor = overdue ? '#d946ef' : (delayed ? '#eab308' : proj.color);
                            const barOpacity = task.status === 'done' ? '0.4' : '1';
                            const barShadow = task.status === 'done' ? 'none' : `0 4px 10px ${barColor}30`;

                            html += `
                                <div class="absolute h-5 rounded-md shadow-sm flex items-center overflow-hidden cursor-pointer transition-all hover:scale-[1.02] border-2 border-white" 
                                     style="left: ${left+2}px; width: ${w-4}px; background-color: ${barColor}20; top: 50%; transform: translateY(-50%); box-shadow: ${barShadow};"
                                     onclick="openTaskModal('${task.id}')" title="${task.title} (${progressPercent}%)">
                                    <div class="absolute left-0 top-0 bottom-0 shadow-inner" style="width: ${progressPercent}%; background-color: ${barColor}; opacity: ${barOpacity};"></div>
                                    <span class="relative z-10 px-2 text-[10px] font-black text-white mix-blend-difference truncate">${w > 45 ? progressPercent+'%' : ''}</span>
                                </div>
                            `;
                        }
                    }
                    html += `</div></div>`;

                    if (isExp && task.subtasks.length > 0) {
                        task.subtasks.forEach(st => {
                            html += `
                            <div class="flex border-b border-dashed border-slate-200 bg-slate-50/30">
                                <div style="width: ${currentHeaderWidth}px; min-width: ${currentHeaderWidth}px;" class="py-2 pl-14 pr-4 border-r-2 border-slate-200 ${stickyClass} flex items-center justify-between">
                                    <div class="flex items-center gap-2.5 overflow-hidden">
                                        <i class="${st.completed ? 'fa-solid fa-square-check text-cyan-500' : 'fa-regular fa-square text-slate-300'} text-xs"></i>
                                        <span class="truncate text-[12px] font-mono font-bold text-slate-500 uppercase ${st.completed ? 'line-through opacity-50' : ''}">${st.title}</span>
                                    </div>
                                    <div class="flex gap-2.5 text-[10px] font-mono font-black text-slate-400 uppercase"><span>${st.progress||0}%</span><span>${st.hours}h</span></div>
                                </div>
                                <div class="flex-1"></div>
                            </div>`;
                        });
                    }
                });
            });
            html += `</div></div>`;
            return html;
        }

        function generateLegend(projects) {
            const legendMap = new Map();
            projects.forEach(p => {
                if(p.milestones) {
                    p.milestones.forEach(ms => {
                        if(!legendMap.has(ms.name)) {
                            legendMap.set(ms.name, `<div class="flex items-center gap-1.5"><i class="fa-solid ${ms.icon||'fa-flag'}" style="color:${ms.color||'#4b5563'}"></i><span>${ms.name}</span></div>`);
                        }
                    });
                }
            });
            let html = Array.from(legendMap.values()).join('<span class="mx-2 text-slate-800">|</span>');
            if(!html) html = '<span class="text-slate-600">有効な案件データはありません</span>';
            document.getElementById('gantt-legend').innerHTML = `<span class="font-bold text-slate-300 mr-3 uppercase tracking-widest"><i class="fa-solid fa-tags mr-2 text-cyan-500"></i>マイルストーン凡例:</span>${html}`;
        }

        function getGanttDateRange(rangeType, filteredTasks, filteredProjects = []) {
            let startDate, endDate;
            const today = new Date();
            
            if (rangeType === 'month') { 
                startDate = new Date(today.getFullYear(), today.getMonth(), 1); 
                endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0); 
            }
            else if (rangeType === 'multi-month') { 
                startDate = new Date(today.getFullYear(), today.getMonth(), 1); 
                endDate = new Date(today.getFullYear(), today.getMonth() + 2, 0); 
            }
            else { 
                let min = new Date('2099-12-31'); let max = new Date('1970-01-01');
                let found = false;

                filteredTasks.forEach(t => {
                    if (t.startDate) { const d = new Date(t.startDate); if (d < min) min = d; found = true; }
                    if (t.dueDate) { const d = new Date(t.dueDate); if (d > max) max = d; found = true; }
                });

                filteredProjects.forEach(p => {
                    if(p.milestones) {
                        p.milestones.forEach(ms => {
                            if(ms.type === 'point' && ms.date) {
                                const d = new Date(ms.date); if(d < min) min = d; if(d > max) max = d; found = true;
                            } else if (ms.type === 'range') {
                                if(ms.startDate) { const d = new Date(ms.startDate); if(d < min) min = d; found = true; }
                                if(ms.endDate) { const d = new Date(ms.endDate); if(d > max) max = d; found = true; }
                            }
                        });
                    }
                });

                if(!found) {
                    startDate = new Date(today.getFullYear(), today.getMonth(), 1); 
                    endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0);
                } else {
                    startDate = new Date(min.getFullYear(), min.getMonth(), 1); 
                    endDate = new Date(max.getFullYear(), max.getMonth() + 1, 0); 
                }
            }
            startDate.setHours(0,0,0,0); endDate.setHours(0,0,0,0);
            return { startDate, endDate };
        }

        function renderGantt() {
            const container = document.getElementById('gantt-container');
            const rangeType = document.getElementById('gantt-range').value;
            
            let filteredProjects = state.projects;
            
            // 1. Strictly hide hidden completed projects
            if (!state.showCompletedProjects) {
                filteredProjects = filteredProjects.filter(p => !isProjectCompleted(p.id));
            }

            // 2. Further filter by user selection if any
            if (state.ganttSelectedProjects.size > 0) {
                filteredProjects = filteredProjects.filter(p => state.ganttSelectedProjects.has(p.id));
            }

            generateLegend(filteredProjects);

            const filteredTasks = state.tasks.filter(t => filteredProjects.some(p => p.id === t.projectId));
            const { startDate, endDate } = getGanttDateRange(rangeType, filteredTasks, filteredProjects);
            container.innerHTML = generateGanttHTML(startDate, endDate, filteredProjects, filteredTasks);
        }

        function filterGanttByWeek(startStr, endStr) {
            const start = new Date(startStr).getTime();
            const end = new Date(endStr).setHours(23,59,59,999);

            const activeProjectIds = new Set();

            state.tasks.forEach(t => {
                if (!t.startDate || !t.dueDate) return;
                const ts = new Date(t.startDate).getTime();
                const te = new Date(t.dueDate).setHours(23,59,59,999);
                if (ts <= end && te >= start) activeProjectIds.add(t.projectId);
            });

            state.projects.forEach(p => {
                if (activeProjectIds.has(p.id)) return;
                if (p.milestones) {
                    p.milestones.forEach(ms => {
                        if (ms.type === 'point' && ms.date) {
                            const t = new Date(ms.date).getTime();
                            if (t >= start && t <= end) activeProjectIds.add(p.id);
                        } else if (ms.type === 'range' && ms.startDate && ms.endDate) {
                            const ts = new Date(ms.startDate).getTime();
                            const te = new Date(ms.endDate).setHours(23,59,59,999);
                            if (ts <= end && te >= start) activeProjectIds.add(p.id);
                        }
                    });
                }
            });

            if (activeProjectIds.size === 0) {
                showDialog('案内', '指定された週にタスクがある案件は見つかりませんでした。', 'info');
                return;
            }

            state.ganttSelectedProjects = activeProjectIds;
            document.getElementById('gantt-selected-count').innerText = state.ganttSelectedProjects.size;
            renderGantt();
        }

        function dragStartWeeklyAdhoc(ev, name, duration, isFree) {
            ev.dataTransfer.setData("text/plain", JSON.stringify({ type: 'adhoc', name, duration, isFree }));
        }

        // Set up Auth observer immediately
        onAuthStateChanged(auth, (user) => {
            console.log("Auth State Changed:", user ? "LoggedIn" : "LoggedOut");
            const overlay = document.getElementById('login-overlay');
            if(user) {
                currentUser = user;
                overlay.classList.add('opacity-0', 'pointer-events-none');
                setTimeout(() => overlay.classList.add('hidden'), 300);
                
                // Sync initial UI state
                document.querySelectorAll('.show-completed-toggle').forEach(el => el.checked = state.showCompletedProjects);

                setupFirestoreListeners();
                executeSwitchView(state.currentView);
            } else {
                currentUser = null;
                overlay.classList.remove('hidden');
                setTimeout(() => overlay.classList.remove('opacity-0', 'pointer-events-none'), 10);
            }
        });

        // Export functions and variables to window
        Object.assign(window, {
            // Auth
            loginWithEmail, registerWithEmail, loginWithGoogle, logoutUser,
            // UI View & Filters
            switchView, updateProjectFilters, changeWeek, resetToCurrentWeek, toggleAccordion,
            // Weekly View
            renderWeekly, dragStartWeeklyPool, dragStartWeeklyTimeline, allowWeeklyDropContainer,
            dragWeeklyLeaveContainer, dropWeeklyContainer, unassignBlock, dropToPool,
            dragStartWeeklyAdhoc, addCustomAdHocTemplate, toggleSubtaskNote,
            // Kanban View
            renderKanban, toggleTaskSelection, duplicateSelectedTasks, deleteSelectedTasks,
            dragStart, allowDrop, dragLeave, dropTask,
            // Gantt View
            renderGantt, filterGanttByWeek, handleGanttPrint, toggleGanttTask,
            // Project & Modal Management
            openProjectModal, editCurrentProject, saveProject, deleteCurrentProject,
            toggleProjectStatus, toggleShowCompletedProjects, openProjectSelectModal,
            renderProjectCards, toggleProjectSelection, selectAllProjects, applyProjectSelection,
            updateProjectTemplatesDropdown, toggleProjTemplateSelect, deleteProjectTemplate,
            showModal, closeModal, showDialog,
            // Task Management
            openTaskModal, updateTaskTemplatesDropdown, loadTaskTemplate,
            saveAsTemplate, deleteTaskTemplate, deleteCurrentTask, updateWorkingTask,
            addSubtask, removeSubtask, handleSubtaskChange, saveTask,
            // Milestone Management
            addMilestoneRow, removeMilestoneRow, moveMilestone, handleMilestoneChange, validateDynamicMilestones,
            // Template Editor
            openProjectTemplateModal, addTemplateMilestone, removeTemplateMilestone,
            moveTemplateMilestone, handleTemplateMilestoneChange, handleTemplateTaskChange, saveProjectTemplate,
            // Calendar & Holidays
            openCalendarModal, addCompanyHoliday, removeCompanyHoliday, handlePrint
        });

    