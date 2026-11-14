// Планове и ограничения. Плановете се пазят в таблицата „Cloud - Планове“ и администраторите на БУЛАДМИН
// ги променят от системата. Тези стойности се записват само ако таблицата е празна или планът липсва.
// Празно поле за ограничение означава „без ограничение“.
export const DEFAULT_PLANS = [
  {
    id: 'free', name: 'Безплатен', description: 'За един човек, който започва. Само в евро и с една банкова сметка.', price: 0,
    maxUsers: 1, maxCompanies: 10, maxContacts: 20, maxProducts: 20, maxDeals: 10, maxInvoices: 10, maxOffers: 10,
    maxBankAccounts: 1, maxEmails: 20,
    allowLogo: 'Не', allowCurrencies: 'Не', allowProcurement: 'Не', isDefault: 'Да', isActive: 'Да', sortOrder: 1,
  },
  {
    id: 'standard', name: 'Стандартен', description: 'За малък екип: лого, други валути, няколко банкови сметки и по-високи ограничения.', price: '',
    maxUsers: 5, maxCompanies: 500, maxContacts: 1000, maxProducts: 500, maxDeals: 200, maxInvoices: 200, maxOffers: 200,
    maxBankAccounts: 5, maxEmails: 500,
    allowLogo: 'Да', allowCurrencies: 'Да', allowProcurement: 'Не', isDefault: 'Не', isActive: 'Да', sortOrder: 2,
  },
  {
    id: 'eop', name: 'ЦАИС ЕОП', description: 'Всичко от „Стандартен“ и модул за участие в обществени поръчки като стопански субект.', price: '',
    maxUsers: 10, maxCompanies: 1000, maxContacts: 2000, maxProducts: 1000, maxDeals: 500, maxInvoices: 500, maxOffers: 500,
    maxBankAccounts: 10, maxEmails: 1000,
    allowLogo: 'Да', allowCurrencies: 'Да', allowProcurement: 'Да', isDefault: 'Не', isActive: 'Да', sortOrder: 3,
  },
  {
    id: 'pro', name: 'Професионален', description: 'Без ограничения, включително модула „ЦАИС ЕОП“.', price: '',
    maxUsers: '', maxCompanies: '', maxContacts: '', maxProducts: '', maxDeals: '', maxInvoices: '', maxOffers: '',
    maxBankAccounts: '', maxEmails: '',
    allowLogo: 'Да', allowCurrencies: 'Да', allowProcurement: 'Да', isDefault: 'Не', isActive: 'Да', sortOrder: 4,
  },
];

// Ключ на ограничението, описание за съобщенията и как се брои използваното.
export const LIMITS = {
  maxUsers: { label: 'потребители', monthly: false },
  maxCompanies: { label: 'контрагенти', monthly: false },
  maxContacts: { label: 'лица за контакт', monthly: false },
  maxProducts: { label: 'артикули', monthly: false },
  maxDeals: { label: 'отворени сделки', monthly: false },
  maxInvoices: { label: 'фактури и проформи този месец', monthly: true },
  maxOffers: { label: 'оферти този месец', monthly: true },
  maxBankAccounts: { label: 'банкови сметки', monthly: false },
  maxEmails: { label: 'изпратени имейла до контрагенти този месец', monthly: true },
};

// Възможности, които планът включва или не.
export const FEATURES = {
  allowLogo: 'лого в документите',
  allowCurrencies: 'документи в други валути',
  allowProcurement: 'модул „ЦАИС ЕОП“ за обществени поръчки',
};

export const PLAN_NUMBERS = Object.keys(LIMITS).concat(['price', 'sortOrder']);

export const limitOf = (plan, key) => {
  const value = plan?.[key];
  return value === '' || value === null || value === undefined ? Infinity : Number(value);
};
export const hasFeature = (plan, key) => plan?.[key] === 'Да';

export const defaultPlan = (plans) => plans.find((p) => p.isDefault === 'Да') || plans[0];

// Платеният план важи до planUntil включително; след това организацията минава на плана по подразбиране.
// Изключение са фирмите „само с платен план“ (втора и следваща фирма в профил): те остават на плана си,
// но достъпът до тях спира, докато абонаментът не бъде платен (виж paymentDue).
export function effectivePlan(org, plans, today) {
  const fallback = defaultPlan(plans);
  const plan = plans.find((p) => p.id === org.planId);
  if (!plan) return fallback;
  if (org.paidOnly === 'Да') return plan;
  if (org.planUntil && org.planUntil < today && plan.id !== fallback.id) return fallback;
  return plan;
}

// Фирмата чака плащане: още не е активирана или платеният ѝ период е изтекъл, а безплатен план няма.
export const paymentDue = (org, today) => org.orgStatus === 'Чака плащане'
  || (org.paidOnly === 'Да' && !!org.planUntil && org.planUntil < today);

// Плановете, които могат да се изберат за фирма само с платен план.
export const paidPlans = (plans) => plans.filter((p) => p.isActive === 'Да' && p.isDefault !== 'Да');

const OPEN_STAGES = ['Нова', 'Квалифицирана', 'Оферта', 'Преговори'];
export const EMAIL_ACTION = 'Изпратен по имейл';

// Колко е използвано от всяко ограничение. Фактурите и офертите се броят по месеца на издаване.
export function usageOf({ members, companies, contacts, products, deals, documents, audit = [], bankAccounts = [] }, month) {
  const issuedThisMonth = (types) => documents.filter((d) => types.includes(d.docType)
    && d.docStatus !== 'Чернова' && String(d.issueDate || '').startsWith(month)).length;
  return {
    maxUsers: members.filter((m) => m.isActive === 'Да').length,
    maxCompanies: companies.length,
    maxContacts: contacts.length,
    maxProducts: products.length,
    maxDeals: deals.filter((d) => OPEN_STAGES.includes(d.stage)).length,
    maxInvoices: issuedThisMonth(['Фактура', 'Проформа фактура']),
    maxOffers: issuedThisMonth(['Оферта']),
    maxBankAccounts: bankAccounts.length,
    maxEmails: audit.filter((e) => e.action === EMAIL_ACTION && String(e.occurredAt || '').startsWith(month)).length,
  };
}

export const ENTITY_LIMIT = { companies: 'maxCompanies', contacts: 'maxContacts', products: 'maxProducts', deals: 'maxDeals' };
export const DOC_LIMIT = { 'Фактура': 'maxInvoices', 'Проформа фактура': 'maxInvoices', 'Оферта': 'maxOffers' };
