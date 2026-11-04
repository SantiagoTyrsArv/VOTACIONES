import './styles.css';
import { PublicResultsApp } from './PublicResultsApp.js';

const root = document.querySelector<HTMLElement>('#app');
if (root) new PublicResultsApp(root).start(new URLSearchParams(location.search));
