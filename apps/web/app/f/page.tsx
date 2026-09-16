'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { AppPage } from '../../components/app-page';

function FolderByQuery() {
  const params = useSearchParams();
  const folderId = params.get('id');
  return <AppPage initialRoute={folderId ? { view: 'drive', folderId } : { view: 'drive' }} />;
}

export default function FolderPage() {
  return (
    <Suspense>
      <FolderByQuery />
    </Suspense>
  );
}
