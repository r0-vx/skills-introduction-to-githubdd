import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RailwayBookingDemo } from './RailwayBookingDemo';
import '../ui/global.css';
import '../ui/railway-demo.css';

createRoot(document.getElementById('root')!).render(<StrictMode><RailwayBookingDemo /></StrictMode>);
