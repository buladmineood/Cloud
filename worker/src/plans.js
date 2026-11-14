// Планове и ограничения. Плановете се пазят в таблицата „Cloud - Планове“ и администраторите на БУЛАДМИН
// ги променят от системата. Тези стойности се записват само ако таблицата е празна.
// Празно поле за ограничение означава „без ограничение“.
export const DEFAULT_PLANS = [
  {
    id: 'free', name: 'Безплатен', description: 'За един човек, който започва.', price: 0,
    maxUsers: 1, maxCompanies: 10, maxContacts: 20, maxProducts: 20, maxDeals: 10, maxInvoices: 10, maxOffers: 10,
    allowLogo: 'Не', isDefault: 'Да', isActive: 'Да', sortOrder: 1,
  },
  {
    id: 'standard', name: 'Стандартен', description: 'За малък екип: лого в документите и по-високи ограничения.', price: '',
    maxUsers: 5, maxCompanies: 500, maxContacts: 1000, maxProducts: 500, maxDeals: 200, maxInvoices: 200, maxOffers: 200,
    allowLogo: 'Да', isDefault: 'Не', isActive: 'Да', sortOrder: 2,
  },
  {
    id: 'pro', name: 'Професионален', description: 'Без ограничения.', price: '',
    maxUsers: '', maxCompanies: '', maxContacts: '', maxProducts: '', maxDeals: '', maxInvoices: '', maxOffers: '',
    allowLogo: 'Да', isDefault: 'Не', isActive: 'Да', sortOrder: 3,
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
};

export const PLAN_NUMBERS = Object.keys(LIMITS).concat(['price', 'sortOrder']);

export const limitOf = (plan, key) => {
  const value = plan?.[key];
  return value === '' || value === null || value === undefined ? Infinity : Number(value);
};

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

// Колко е използвано от всяко ограничение. Фактурите и офертите се броят по месеца на издаване.
export function usageOf({ members, companies, contacts, products, deals, documents }, month) {
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
  };
}

export const ENTITY_LIMIT = { companies: 'maxCompanies', contacts: 'maxContacts', products: 'maxProducts', deals: 'maxDeals' };
export const DOC_LIMIT = { 'Фактура': 'maxInvoices', 'Проформа фактура': 'maxInvoices', 'Оферта': 'maxOffers' };
