import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom';
import AccountDetailPage from './pages/AccountDetailPage';
import AccountListPage from './pages/AccountListPage';
import ProjectionPage from './pages/ProjectionPage';

export default function App() {
  return (
    <BrowserRouter>
      <header className="topbar">
        <div className="topbar-inner">
          <span className="logo">事件溯源 · 管理后台</span>
          <nav>
            <NavLink to="/" end>
              账户（读模型）
            </NavLink>
            <NavLink to="/projection">投影与重放</NavLink>
          </nav>
        </div>
      </header>
      <main className="container">
        <Routes>
          <Route path="/" element={<AccountListPage />} />
          <Route path="/accounts/:id" element={<AccountDetailPage />} />
          <Route path="/projection" element={<ProjectionPage />} />
        </Routes>
      </main>
    </BrowserRouter>
  );
}
