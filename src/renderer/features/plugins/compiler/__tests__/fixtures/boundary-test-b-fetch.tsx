/**
 * Boundary Test B: Using fetch() to call external API
 *
 * Tests whether the AST validator blocks fetch(). fetch is a global
 * browser API and is NOT in the forbidden patterns list (eval, innerHTML,
 * Function, document.write). Expected: compile succeeds (fetch is not blocked).
 */
import { useState } from 'react';
import { Card, Stack, Button } from '@rebel/plugin-ui';

interface QuoteData {
  content: string;
  author: string;
}

export default function FetchPlugin() {
  const [quote, setQuote] = useState<QuoteData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchQuote = () => {
    setLoading(true);
    setError(null);
    fetch('https://api.quotable.io/random')
      .then((res) => res.json())
      .then((data: QuoteData) => {
        setQuote(data);
        setLoading(false);
      })
      .catch((err: Error) => {
        setError(err.message);
        setLoading(false);
      });
  };

  return (
    <Stack gap="sm">
      <div style={{ padding: '1rem' }}>
        <h2 style={{ fontSize: '1.125rem', fontWeight: 600 }}>Random Quote</h2>
      </div>
      <div style={{ padding: '0 1rem 1rem' }}>
        <Card>
          {quote && (
            <div>
              <p style={{ fontSize: '0.875rem', fontStyle: 'italic' }}>"{quote.content}"</p>
              <p style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>— {quote.author}</p>
            </div>
          )}
          {loading && <p style={{ fontSize: '0.8125rem' }}>Loading...</p>}
          {error && <p style={{ fontSize: '0.8125rem', color: 'red' }}>{error}</p>}
          <Button onClick={fetchQuote} disabled={loading}>
            {quote ? 'New Quote' : 'Get Quote'}
          </Button>
        </Card>
      </div>
    </Stack>
  );
}
