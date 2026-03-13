import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', redirectTo: 'agenda', pathMatch: 'full' },
  {
    path: 'agenda',
    loadComponent: () =>
      import('./components/agenda/agenda.component').then(m => m.AgendaComponent)
  },
  { path: '**', redirectTo: 'agenda' }
];
