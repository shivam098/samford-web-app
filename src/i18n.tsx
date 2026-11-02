import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { translate, type Language } from '../shared/i18n.js';
const LanguageContext = createContext<{ language: Language; setLanguage: (language: Language) => void }>({ language: 'English', setLanguage: () => { throw new Error('Language provider is missing.'); } });
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, update] = useState<Language>(() => localStorage.getItem('samford-ui-language') === 'Hindi' ? 'Hindi' : 'English');
  const setLanguage = (language: Language) => { localStorage.setItem('samford-ui-language', language); update(language); };
  useEffect(() => { document.documentElement.lang = language === 'Hindi' ? 'hi' : 'en'; }, [language]);
  return <LanguageContext.Provider value={{ language, setLanguage }}>{children}</LanguageContext.Provider>;
}
export function useI18n() {
  const context = useContext(LanguageContext);
  return { ...context, t: (value: string) => translate(value, context.language) };
}
export function LanguageSelect({ onChange }: { onChange?: (language: Language) => void }) {
  const { language, setLanguage } = useI18n();
  return <select className="language-select" aria-label="Language / भाषा" value={language} onChange={event => {
    const value: Language = event.target.value === 'Hindi' ? 'Hindi' : 'English'; setLanguage(value); onChange?.(value);
  }}><option value="English">English</option><option value="Hindi">हिन्दी</option></select>;
}
