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

    console.log('Всего транзакций:', allTransactions.length);

    if (allTransactions.length === 0) {
        document.getElementById('loading').classList.add('hidden');
        alert('Транзакции не найдены. Откройте консоль (F12) для деталей.');
        return;
    }

    allTransactions = removeDuplicates(allTransactions);
    allTransactions.sort((a, b) => {
        const dateA = a.date.split('.').reverse().join('');
        const dateB = b.date.split('.').reverse().join('');
        return dateA.localeCompare(dateB);
    });
    
    updateUI();
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('results').classList.remove('hidden');
}

async function processPDFFile(file) {
    try {
        console.log('\n=== Обработка файла:', file.name, '===');
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        
        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            const page = await pdf.getPage(pageNum);
            const textContent = await page.getTextContent();
            
            // Собираем весь текст страницы
            let fullPageText = textContent.items.map(item => item.str).join(' ');
            
            // Разбиваем на строки по датам
            const datePattern = /(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2})/g;
            let parts = fullPageText.split(datePattern);
            
            for (let i = 1; i < parts.length; i += 2) {
                const dateTime = parts[i];
                const content = parts[i + 1] || '';
                const line = dateTime + ' ' + content;
                
                if (pageNum === 1 && i <= 5) {
                    console.log(`Строка ${i}:`, line.substring(0, 200));
                }
                
                const transaction = parseBelinvestbankLine(line);
                if (transaction) {
                    allTransactions.push(transaction);
                    if (pageNum === 1 && allTransactions.length <= 5) {
                        console.log('✓ Распознано:', transaction);
                    }
                }
            }
        }
    } catch (error) {
        console.error('Ошибка:', error);
        alert(`Ошибка обработки файла: ${error.message}`);
    }
}

function parseBelinvestbankLine(line) {
    // Извлекаем дату
    const dateMatch = line.match(/(\d{2}\.\d{2}\.\d{4})/);
    if (!dateMatch) return null;
    const date = dateMatch[1];
    
    // Пропускаем заголовки
    if (/Итого|Остаток на|Выписка|Дата и время/i.test(line)) return null;
    
    // Извлекаем ID операции (8-9 цифр после даты и времени)
    const idMatch = line.match(/\d{2}:\d{2}\s+(\d{8,9})/);
    if (!idMatch) return null;
    
    // Находим все числа (возможные суммы)
    const numberPattern = /\b(\d+(?:\.\d{1,2})?)\b/g;
    const numbers = [];
    let match;
    while ((match = numberPattern.exec(line)) !== null) {
        const num = parseFloat(match[1]);
        // Пропускаем ID, даты, время
        if (num >= 1000000 || match[1].length === 8 || match[1].length === 9) continue;
        if (num > 0 && num < 100000) {
            numbers.push(num);
        }
    }
    
    if (numbers.length < 1) return null;
    
    // Определяем тип операции по ключевым словам
    let type = '';
    let amount = 0;
    
    const isIncome = /Пополнение кошелька|Пополнение электронного|Получен|Приход/i.test(line);
    const isExpense = /Перевод|Оплата|Вывод|Списание|Расход/i.test(line);
    
    if (isIncome && !isExpense) {
        // Для пополнений первое число - это сумма прихода
        amount = numbers[0];
        type = 'income';
    } else if (isExpense) {
        // Для переводов и оплат берем первое число как расход
        amount = -numbers[0];
        type = 'expense';
    } else {
        return null;
    }
    
    // Извлекаем описание (текст между ID и числами)
    let description = line
        .replace(/\d{2}\.\d{2}\.\d{4}/, '')
        .replace(/\d{2}:\d{2}/, '')
        .replace(/\d{8,9}/, '')
        .replace(/BYN/g, '')
        .replace(/\d+(\.\d{1,2})?/g, '')
        .trim()
        .substring(0, 100);
    
    if (!description) description = 'Операция';
    
    return { date, description, amount, type };
}

function removeDuplicates(transactions) {
    const seen = new Set();
    return transactions.filter(t => {
        const key = `${t.date}|${t.amount.toFixed(2)}|${t.description.substring(0, 20)}`;
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
