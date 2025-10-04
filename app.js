pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

let allTransactions = [];

const uploadArea = document.getElementById('uploadArea');
const fileInput = document.getElementById('fileInput');

uploadArea.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        handleFiles(Array.from(e.target.files));
    }
});

async function handleFiles(files) {
    document.getElementById('fileList').classList.remove('hidden');
    document.getElementById('fileNames').innerHTML = files.map(f => 
        `<span class="px-3 py-1.5 bg-indigo-100 text-indigo-700 rounded-full text-sm">${f.name}</span>`
    ).join('');

    document.getElementById('loading').classList.remove('hidden');
    document.getElementById('results').classList.add('hidden');

    allTransactions = [];

    for (const file of files) {
        await processPDFFile(file);
    }

    if (allTransactions.length === 0) {
        document.getElementById('loading').classList.add('hidden');
        alert('Транзакции не найдены');
        return;
    }

    allTransactions = removeDuplicates(allTransactions);
    allTransactions.sort((a, b) => new Date(a.date.split('.').reverse().join('-')) - new Date(b.date.split('.').reverse().join('-')));
    
    updateUI();
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('results').classList.remove('hidden');
}

async function processPDFFile(file) {
    try {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        
        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            const page = await pdf.getPage(pageNum);
            const textContent = await page.getTextContent();
            
            // Собираем текст построчно по Y-координатам
            const lines = {};
            textContent.items.forEach(item => {
                const y = Math.round(item.transform[5]);
                if (!lines[y]) lines[y] = [];
                lines[y].push({ text: item.str, x: item.transform[4] });
            });
            
            // Сортируем строки
            Object.keys(lines)
                .sort((a, b) => b - a)
                .forEach(y => {
                    const line = lines[y]
                        .sort((a, b) => a.x - b.x)
                        .map(item => item.text)
                        .join(' ');
                    
                    parseBelinvestbankLine(line);
                });
        }
    } catch (error) {
        console.error('Ошибка:', error);
    }
}

function parseBelinvestbankLine(line) {
    // Пропускаем заголовки и итоги
    if (!line || !/\d{2}\.\d{2}\.\d{4}/.test(line)) return;
    if (/Итого|Остаток на|Выписка|Период|Дата и время/i.test(line)) return;
    
    // Формат Белинвестбанка:
    // ДД.ММ.ГГГГ ЧЧ:ММ ID_ОПЕРАЦИИ ТИП_ПЛАТЕЖА ПРИХОД РАСХОД ОСТАТОК BYN ДЕТАЛИ
    
    const dateMatch = line.match(/(\d{2}\.\d{2}\.\d{4})\s+\d{2}:\d{2}\s+\d+/);
    if (!dateMatch) return;
    
    const date = dateMatch[1];
    
    // Ищем три последовательных числа перед BYN (приход, расход, остаток)
    const pattern = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+BYN/;
    const match = line.match(pattern);
    
    if (!match) return;
    
    const num1 = parseFloat(match[1]);
    const num2 = parseFloat(match[2]);
    const num3 = parseFloat(match[3]);
    
    // Определяем приход/расход:
    // - Если num1 > 0 и num2 == 0 → приход = num1
    // - Если num2 > 0 и num1 == 0 → расход = num2
    // - num3 всегда остаток (не используем)
    
    let amount = 0;
    let type = '';
    
    if (num1 > 0 && num2 === 0) {
        // Приход
        amount = num1;
        type = 'income';
    } else if (num2 > 0) {
        // Расход
        amount = -num2;
        type = 'expense';
    } else {
        return; // Не можем определить
    }
    
    // Извлекаем описание (между ID и числами)
    const descMatch = line.match(/\d+\s+(.+?)\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+BYN/);
    const description = descMatch ? descMatch[1].trim().substring(0, 100) : 'Операция';
    
    allTransactions.push({ date, description, amount, type });
}

function removeDuplicates(transactions) {
    const seen = new Set();
    return transactions.filter(t => {
        const key = `${t.date}|${t.amount.toFixed(2)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function updateUI() {
    const income = allTransactions.filter(t => t.type === 'income').reduce((s, t) => s + Math.abs(t.amount), 0);
    const expense = allTransactions.filter(t => t.type === 'expense').reduce((s, t) => s + Math.abs(t.amount), 0);
    const balance = income - expense;

    document.getElementById('totalIncome').textContent = `${income.toFixed(2)} BYN`;
    document.getElementById('totalExpense').textContent = `${expense.toFixed(2)} BYN`;
    document.getElementById('balance').textContent = `${balance.toFixed(2)} BYN`;
    document.getElementById('balance').className = `text-3xl font-bold ${balance >= 0 ? 'text-green-600' : 'text-red-600'}`;

    document.getElementById('periodInfo').textContent = `${allTransactions[0].date} - ${allTransactions[allTransactions.length - 1].date}`;
    document.getElementById('transactionCount').textContent = allTransactions.length;

    updateChart(income, expense);
    updateTransactionTable();
}

function updateChart(income, expense) {
    const total = income + expense;
    const ih = total > 0 ? (income / total) * 200 : 0;
    const eh = total > 0 ? (expense / total) * 200 : 0;

    document.getElementById('chart').innerHTML = `
        <div class="text-center">
            <div class="w-32 bg-gradient-to-t from-green-600 to-green-400 rounded-t-lg transition-all duration-500 shadow-lg" style="height: ${ih}px"></div>
            <p class="mt-3 font-semibold">Доходы</p>
            <p class="text-sm text-gray-600">${income.toFixed(2)} BYN</p>
        </div>
        <div class="text-center">
            <div class="w-32 bg-gradient-to-t from-red-600 to-red-400 rounded-t-lg transition-all duration-500 shadow-lg" style="height: ${eh}px"></div>
            <p class="mt-3 font-semibold">Расходы</p>
            <p class="text-sm text-gray-600">${expense.toFixed(2)} BYN</p>
        </div>
    `;
}

function updateTransactionTable() {
    document.getElementById('transactionList').innerHTML = allTransactions.map(t => `
        <tr class="border-b hover:bg-gray-50">
            <td class="py-3 px-4">${t.date}</td>
            <td class="py-3 px-4">${t.description}</td>
            <td class="py-3 px-4 text-right font-semibold ${t.type === 'income' ? 'text-green-600' : 'text-red-600'}">
                ${t.amount > 0 ? '+' : ''}${t.amount.toFixed(2)} BYN
            </td>
            <td class="py-3 px-4 text-center">
                <span class="px-3 py-1 rounded-full text-xs ${t.type === 'income' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}">
                    ${t.type === 'income' ? 'Доход' : 'Расход'}
                </span>
            </td>
        </tr>
    `).join('');
}

document.getElementById('exportBtn').addEventListener('click', () => {
    if (allTransactions.length === 0) return;

    const income = allTransactions.filter(t => t.type === 'income').reduce((s, t) => s + Math.abs(t.amount), 0);
    const expense = allTransactions.filter(t => t.type === 'expense').reduce((s, t) => s + Math.abs(t.amount), 0);

    const data = [
        ['Анализ выписок'],
        [''],
        ['Период:', `${allTransactions[0].date} - ${allTransactions[allTransactions.length - 1].date}`],
        ['Транзакций:', allTransactions.length],
        ['Доходы:', income.toFixed(2), 'BYN'],
        ['Расходы:', expense.toFixed(2), 'BYN'],
        ['Баланс:', (income - expense).toFixed(2), 'BYN'],
        [''],
        ['Дата', 'Описание', 'Сумма', 'Валюта', 'Тип'],
        ...allTransactions.map(t => [t.date, t.description, Math.abs(t.amount).toFixed(2), 'BYN', t.type === 'income' ? 'Доход' : 'Расход'])
    ];

    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [{wch: 12}, {wch: 50}, {wch: 12}, {wch: 8}, {wch: 10}];
    
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Транзакции');
    XLSX.writeFile(wb, `statements_${new Date().toISOString().split('T')[0]}.xlsx`);
});
