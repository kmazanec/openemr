import type { ReactElement } from 'react';
import { useParams } from '@tanstack/react-router';

export function PatientRoute(): ReactElement {
  const { pid } = useParams({ from: '/patient/$pid' });
  return (
    <div>
      <h1>Patient {pid}</h1>
      <p>Patient header and clinical cards land here in T4.</p>
    </div>
  );
}
