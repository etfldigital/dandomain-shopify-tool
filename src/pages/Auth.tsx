import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { AuthForm } from '@/components/auth/AuthForm';
import { useAuth } from '@/hooks/useAuth';

export default function Auth() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && user) {
      navigate('/');
    }
  }, [user, loading, navigate]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-7 h-7 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <div className="flex-1 flex items-center justify-center p-6 sm:p-8">
        <div className="w-full max-w-md">
          <div className="text-center mb-10">
            <h2 className="text-sm font-medium text-primary uppercase tracking-wider mb-2">
              DanDomain → Shopify
            </h2>
            <p className="text-muted-foreground text-sm">
              Migrér din webshop på få minutter
            </p>
          </div>
          <AuthForm />
        </div>
      </div>
      
      <footer className="text-center py-6 text-sm text-muted-foreground">
        © {new Date().getFullYear()} Migration Tool
      </footer>
    </div>
  );
}
