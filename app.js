pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

let allTransactions = [];
let debugMode = true; // Включаем отладку

const uploadArea = document.getElementById('uploadArea');
const fileInput = document.getElementById('fileInput');

uploadArea.addEventListener('click', () => fileInput.click());

uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('border-indigo-500', 'bg-indigo-50');
});

uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('border-indigo-500', 'bg-indigo-50');
});

uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('border-indigo-500', 'bg-indigo-50');
    const files = Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf');
    if (files.length > 0) {
        handleFiles(files);
    }
});

fileInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files);
    if (files.length > 0) {
        handleFiles(files);
    }
});

async function handleFiles(files) {
    const fileList = document.getElementById('fileList');
    const fileNames = document.getElementById('fileNames');
    fileList.classList.remove('hidden');
    fileNames.innerHTML = files.map(f => 
        `<span class="px-3 py-1.5 bg-indigo-100 text-indigo-700 rounded-full text-sm font-medium">${f.name}</span>`
    ).join('');

    document.getElementById('loading').classList.remove('hidden');
    document.getElementById('results').classList.add('hidden');

    allTransactions = [];

    for (const file of files) {
        await processPDFFile(file);
    }

    console.log('Всего найдено транзакций:', allTransactions.length);

    if (allTransactions.length === 0) {
        document.getElementById('loading').classList.add('hidden');
        alert('Не удалось распознать транзакции. Откройте консоль (F12) и отправьте разработчику скриншот для помощи.');
        return;
    }

    allTransactions = removeDuplicates(allTransactions);
    sortTransactions();
    updateUI();
    
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('results').classList.remove('hidden');
}

async function processPDFFile(file) {
    try {
        console.log(`Обработка файла: ${file.name}`);
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        
        let fullText = '';
        
        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            const page = await pdf.getPage(pageNum);
            const textContent = await page.getTextContent();
            
            // Собираем весь текст страницы
            const pageText = textContent.items.map(item => item.str).join(' ');
            fullText += pageText + '\n';
            
            // Также пробуем построчный парсинг
            const lines = {};
            textContent.items.forEach(item => {
                const y = Math.round(item.transform[5] / 2);
                if (!lines[y]) lines[y] = [];
                lines[y].push({
                    text: item.str,
                    x: item.transform[4]
                });
            });
            
            const sortedLines = Object.keys(lines)
                .sort((a, b) => b - a)
                .map(y => {
                    return lines[y]
                        .sort((a, b) => a.x - b.x)
                        .map(item => item.text)
                        .join(' ');
                });
            
            sortedLines.forEach(line => {
                if (debugMode && pageNum === 1) {
                    console.log('Строка:', line);
                }
                parseTransactionLine(line);
            });
        }
        
        // Если построчный парсинг не сработал, пробуем парсить весь текст
        if (allTransactions.length === 0) {
            console.log('Построчный парсинг не дал результатов, пробуем парсить весь текст...');
            parseFullText(fullText);
        }
        
    } catch (error) {
        console.error('Ошибка обработки PDF:', error);
        alert(`Ошибка при обработке файла ${file.name}: ${error.message}`);
    }
}

function parseFullText(text) {
    // Разбиваем на строки
    const lines = text.split('\n');
    
    lines.forEach(line => {
        parseTransactionLine(line);
    });
}

function parseTransactionLine(line) {
    if (!line || line.trim().length === 0) return;
    if (!/\d{2}\.\d{2}\.\d{4}/.test(line)) return;
    if (/Итого|обороты|Остаток на|Выписка по|Период|Владелец|Номер счёта/i.test(line)) return;
    
    // Пробуем все варианты парсинга
    let transaction = null;
    
    transaction = parseBelinvestbankV1(line);
    if (transaction) {
        allTransactions.push(transaction);
        return;
    }
    
    transaction = parseBelinvestbankV2(line);
    if (transaction) {
        allTransactions.push(transaction);
        return;
    }
    
    transaction = parseBNBBankV1(line);
    if (transaction) {
        allTransactions.push(transaction);
        return;
    }
    
    transaction = parseBNBBankV2(line);
    if (transaction) {
        allTransactions.push(transaction);
        return;
    }
}

// Белинвестбанк - вариант 1
function parseBelinvestbankV1(line) {
    const pattern = /(\d{2}\.\d{2}\.\d{4})\s+\d{2}:\d{2}\s+\d+\s+(.*?)\s+([\d.]+)?\s+([\d.]+)\s+[\d.]+\s+BYN\s+(.+)/;
    const match = line.match(pattern);
    
    if (!match) return null;
    
    const date = match[1];
    const type = match[2].trim();
    const col1 = match[3] ? parseFloat(match[3]) : 0;
    const col2 = parseFloat(match[4]);
    const description = match[5].trim();
    
    let amount, transactionType;
    
    if (col1 > 0 && col1 !== col2) {
        amount = col1;
        transactionType = 'income';
    } else if (col2 > 0) {
        amount = -col2;
        transactionType = 'expense';
    } else {
        return null;
    }
    
    return {
        date,
        description: `${type} - ${description}`.substring(0, 100),
        amount,
        type: transactionType
    };
}

// Белинвестбанк - вариант 2 (более гибкий)
function parseBelinvestbankV2(line) {
    const dateMatch = line.match(/(\d{2}\.\d{2}\.\d{4})/);
    if (!dateMatch) return null;
    
    const date = dateMatch[1];
    
    // Ищем BYN и числа вокруг него
    const bynPattern = /([\d.]+)\s+([\d.]+)\s+BYN/g;
    const matches = [...line.matchAll(bynPattern)];
    
    if (matches.length === 0) return null;
    
    // Берем последнее совпадение (обычно это приход/расход)
    const lastMatch = matches[matches.length - 1];
    const num1 = parseFloat(lastMatch[1]);
    const num2 = parseFloat(lastMatch[2]);
    
    // Извлекаем описание (всё между датой и числами)
    const descStart = line.indexOf(date) + date.length;
    const descEnd = line.indexOf(lastMatch[0]);
    let description = line.substring(descStart, descEnd).trim();
    description = description.replace(/\d{2}:\d{2}/, '').replace(/\d+/, '').trim();
    
    let amount, type;
    
    if (num1 > 0 && num2 > 0 && num1 !== num2) {
        if (num1 < num2) {
            amount = num1;
            type = 'income';
        } else {
            amount = -num1;
            type = 'expense';
        }
    } else if (num1 > 0) {
        amount = -num1;
        type = 'expense';
    } else {
        return null;
    }
    
    return {
        date,
        description: description.substring(0, 100),
        amount,
        type
    };
}

// БНБ-Банк - вариант 1
function parseBNBBankV1(line) {
    const pattern = /(\d{2}\.\d{2}\.\d{4})\s+\d{2}:\d{2}:\d{2}\s+\d{2}\.\d{2}\.\d{4}\s+(.+?)\s+([-\d,]+)\s+BYN\s+([-\d,]+)\s+BYN/;
    const match = line.match(pattern);
    
    if (!match) return null;
    
    const date = match[1];
    const description = match[2].trim();
    const amountStr = match[4].replace(',', '.');
    const amount = parseFloat(amountStr);
    
    if (isNaN(amount) || Math.abs(amount) < 0.01) return null;
    
    return {
        date,
        description: description.substring(0, 100),
        amount,
        type: amount > 0 ? 'income' : 'expense'
    };
}

// БНБ-Банк - вариант 2
function parseBNBBankV2(line) {
    const dateMatch = line.match(/(\d{2}\.\d{2}\.\d{4})\s+\d{2}:\d{2}:\d{2}/);
    if (!dateMatch) return null;
    
    const date = dateMatch[1];
    
    // Ищем паттерн: число BYN число BYN
    const bynPattern = /([-\d,]+)\s+BYN\s+([-\d,]+)\s+BYN/;
    const match = line.match(bynPattern);
    
    if (!match) return null;
    
    const amount = parseFloat(match[2].replace(',', '.'));
    
    if (isNaN(amount) || Math.abs(amount) < 0.01) return null;
    
    // Описание между датой и числами
    const descStart = line.indexOf(date) + dateMatch[0].length;
    const descEnd = line.indexOf(match[0]);
    const description = line.substring(descStart, descEnd).trim();
    
    return {
        date,
        description: description.substring(0, 100) || 'Операция',
        amount,
        type: amount > 0 ? 'income' : 'expense'
    };
}

function removeDuplicates(transactions) {
    const seen = new Set();
    return transactions.filter(t => {
        const key = `${t.date}|${t.amount.toFixed(2)}|${t.description.substring(0, 30)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function sortTransactions() {
    allTransactions.sort((a, b) => {
        const [dA, mA, yA] = a.date.split('.').map(Number);
        const [dB, mB, yB] = b.date.split('.').map(Number);
        const dateA = new Date(yA, mA - 1, dA);
        const dateB = new Date(yB, mB - 1, dB);
        return dateA - dateB;
    });
}

function updateUI() {
    const income = allTransactions
        .filter(t => t.type === 'income')
        .reduce((sum, t) => sum + Math.abs(t.amount), 0);
    
    const expense = allTransactions
        .filter(t => t.type === 'expense')
        .reduce((sum, t) => sum + Math.abs(t.amount), 0);
    
    const balance = income - expense;

    document.getElementById('totalIncome').textContent = `${income.toFixed(2)} BYN`;
    document.getElementById('totalExpense').textContent = `${expense.toFixed(2)} BYN`;
    document.getElementById('balance').textContent = `${balance.toFixed(2)} BYN`;
    document.getElementById('balance').className = `text-3xl font-bold ${balance >= 0 ? 'text-green-600' : 'text-red-600'}`;

    const firstDate = allTransactions[0].date;
    const lastDate = allTransactions[allTransactions.length - 1].date;
    document.getElementById('periodInfo').textContent = `${firstDate} - ${lastDate}`;
    document.getElementById('transactionCount').textContent = allTransactions.length;

    updateChart(income, expense);
    updateTransactionTable();
}

function updateChart(income, expense) {
    const total = income + expense;
    const incomeHeight = total > 0 ? (income / total) * 200 : 0;
    const expenseHeight = total > 0 ? (expense / total) * 200 : 0;

    document.getElementById('chart').innerHTML = `
        <div class="text-center">
            <div class="w-32 bg-gradient-to-t from-green-600 to-green-400 rounded-t-lg transition-all duration-500 shadow-lg" 
                 style="height: ${incomeHeight}px"></div>
            <p class="mt-3 font-semibold text-gray-800">Доходы</p>
            <p class="text-sm text-gray-600">${income.toFixed(2)} BYN</p>
            <p class="text-xs text-gray-500">${total > 0 ? ((income/total)*100).toFixed(1) : 0}%</p>
        </div>
        <div class="text-center">
            <div class="w-32 bg-gradient-to-t from-red-600 to-red-400 rounded-t-lg transition-all duration-500 shadow-lg" 
                 style="height: ${expenseHeight}px"></div>
            <p class="mt-3 font-semibold text-gray-800">Расходы</p>
            <p class="text-sm text-gray-600">${expense.toFixed(2)} BYN</p>
            <p class="text-xs text-gray-500">${total > 0 ? ((expense/total)*100).toFixed(1) : 0}%</p>
        </div>
    `;
}

function updateTransactionTable() {
    const tbody = document.getElementById('transactionList');
    tbody.innerHTML = allTransactions.map(t => `
        <tr class="border-b border-gray-100 hover:bg-gray-50 transition-colors">
            <td class="py-3 px-4 text-gray-700 whitespace-nowrap">${t.date}</td>
            <td class="py-3 px-4 text-gray-700">${t.description}</td>
            <td class="py-3 px-4 text-right font-semibold whitespace-nowrap ${t.type === 'income' ? 'text-green-600' : 'text-red-600'}">
                ${t.amount > 0 ? '+' : ''}${t.amount.toFixed(2)} BYN
            </td>
            <td class="py-3 px-4 text-center">
                <span class="px-3 py-1 rounded-full text-xs font-semibold ${
                    t.type === 'income' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                }">
                    ${t.type === 'income' ? 'Доход' : 'Расход'}
                </span>
            </td>
        </tr>
    `).join('');
}

document.getElementById('exportBtn').addEventListener('click', exportToExcel);

function exportToExcel() {
    if (allTransactions.length === 0) {
        alert('Нет данных для экспорта');
        return;
    }

    const income = allTransactions
        .filter(t => t.type === 'income')
        .reduce((sum, t) => sum + Math.abs(t.amount), 0);
    
    const expense = allTransactions
        .filter(t => t.type === 'expense')
        .reduce((sum, t) => sum + Math.abs(t.amount), 0);

    const ws_data = [
        ['Анализ банковских выписок'],
        [''],
        ['Период:', `${allTransactions[0].date} - ${allTransactions[allTransactions.length - 1].date}`],
        ['Транзакций:', allTransactions.length],
        ['Доходы:', income.toFixed(2), 'BYN'],
        ['Расходы:', expense.toFixed(2), 'BYN'],
        ['Баланс:', (income - expense).toFixed(2), 'BYN'],
        [''],
        ['Дата', 'Описание', 'Сумма', 'Валюта', 'Тип'],
        ...allTransactions.map(t => [
            t.date,
            t.description,
            Math.abs(t.amount).toFixed(2),
            'BYN',
            t.type === 'income' ? 'Доход' : 'Расход'
        ])
    ];

    const ws = XLSX.utils.aoa_to_sheet(ws_data);
    ws['!cols'] = [{ wch: 12 }, { wch: 50 }, { wch: 12 }, { wch: 8 }, { wch: 10 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Транзакции');
    
    const filename = `bank_statements_${new Date().toISOString().split('T')[0]}.xlsx`;
    XLSX.writeFile(wb, filename);
}
