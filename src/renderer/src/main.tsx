import React from 'react';
import { createRoot } from 'react-dom/client';
import { IdleProtection } from './IdleProtection';
import './style.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <IdleProtection />
  </React.StrictMode>,
);
