 pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
 
 let allTransactions = [];
 let lastParsedTransaction = null;
 
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
         lastParsedTransaction = null;
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
 
 function sanitizeNumber(value) {
     if (!value) return 0;
     return parseFloat(value.replace(/\s+/g, '').replace(',', '.')) || 0;
 }
 
 function parseBelinvestbankLine(rawLine) {
     if (!rawLine) return;
 
     const line = rawLine
         .replace(/\u00a0/g, ' ')
         .replace(/\s+/g, ' ')
         .trim();
 
     if (!line) return;
 
     if (!/\d{2}\.\d{2}\.\d{4}/.test(line)) {
         if (lastParsedTransaction && line.length > 3) {
             lastParsedTransaction.description = `${lastParsedTransaction.description} ${line}`.trim();
         }
         return;
     }
 
     if (/Итого|Остаток на|Выписка|Период|Дата и время|Дата создания операции|Дата отражения/i.test(line)) {
         return;
     }
 
     const linePattern = new RegExp(
         String.raw`^(?<date>\d{2}\.\d{2}\.\d{4})\s+\d{2}:\d{2}(?:\s+\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2})?\s+\d+\s+(?<type>.+?)\s+(?<income>-?[\d\s.,]+)\s+(?<expense>-?[\d\s.,]+)\s+(?<balance>-?[\d\s.,]+)\s+BYN(?<details>.*)$`
     );
     const match = line.match(linePattern);
 
     if (!match || !match.groups) {
         if (lastParsedTransaction && line.length > 3) {
             lastParsedTransaction.description = `${lastParsedTransaction.description} ${line}`.trim();
         }
         return;
     }
 
     const date = match.groups.date;
     const incomeValue = sanitizeNumber(match.groups.income);
     const expenseValue = sanitizeNumber(match.groups.expense);
 
     const amountValue = incomeValue - expenseValue;
     if (amountValue === 0) {
         return;
     }
 
     const type = amountValue >= 0 ? 'income' : 'expense';
     const amount = amountValue;
 
     const descriptionParts = [];
     if (match.groups.type) descriptionParts.push(match.groups.type.trim());
     if (match.groups.details) descriptionParts.push(match.groups.details.trim());
     const description = descriptionParts.join(' ').trim().substring(0, 200) || 'Операция';
 
     const transaction = { date, description, amount, type };
     allTransactions.push(transaction);
     lastParsedTransaction = transaction;
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
 
