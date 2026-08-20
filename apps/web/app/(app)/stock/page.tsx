'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, AlertTriangle } from 'lucide-react';
import type { CurrentUserResponse } from '@billing/types';
import { hasPermission } from '@billing/types';
import { apiFetch, ApiRequestError } from '../../../lib/api-client';
import {
  Button,
  Badge,
  Money,
  Input,
  Select,
  Field,
  Modal,
  EmptyState,
  ErrorState,
  PermissionDenied,
  TableSkeleton,
} from '../../../components/ui/primitives';

/** Stock list. Quantities are decimal strings from the API, never numbers. */

interface StockItem {
  id: string;
  sku: string;
  name: string;
  unit: string;
  unitPrice: string;
  quantityOnHand: string;
  reorderLevel: string;
  tracksStock: boolean;
  isLow: boolean;
}

interface StockPage {
  items: StockItem[];
  total: number;
  page: number;
  totalPages: number;
}

/** Trims trailing zeros for display: "10.0000" reads better as "10". */
const qty = (value: string) => value.replace(/\.?0+$/, '') || '0';

export default function StockPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [adjusting, setAdjusting] = useState<StockItem | null>(null);

  const { data: me } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => apiFetch<CurrentUserResponse>('/auth/me'),
  });

  const params = new URLSearchParams({ limit: '50' });
  if (search) params.set('search', search);
  if (lowOnly) params.set('lowStock', 'true');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['stock', search, lowOnly],
    queryFn: () => apiFetch<StockPage>(`/stock?${params.toString()}`),
    placeholderData: (previous) => previous,
  });

  const role = me?.organisation?.role;
  const canView = role ? hasPermission(role, 'stock:view') : true;
  const canWrite = role ? hasPermission(role, 'stock:write') : false;

  if (role && !canView) return <PermissionDenied />;

  const filtered = Boolean(search || lowOnly);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-h1 text-ink">Stock</h1>
          <p className="mt-1 text-body text-ink-muted">
            {data ? `${data.total} ${data.total === 1 ? 'item' : 'items'}` : ' '}
          </p>
        </div>
        {canWrite && (
          <Link href="/stock/new">
            <Button>
              <Plus className="h-4 w-4" aria-hidden="true" />
              New item
            </Button>
          </Link>
        )}
      </header>

      <div className="flex flex-wrap items-end gap-4 rounded-md border border-border bg-surface p-4 shadow-card">
        <div className="min-w-[240px] flex-1">
          <Field label="Search" htmlFor="stock-search">
            <Input
              id="stock-search"
              value={search}
              placeholder="Name or category"
              onChange={(e) => setSearch(e.target.value)}
            />
          </Field>
        </div>
        <label className="flex h-10 items-center gap-2 text-body-sm text-ink-secondary">
          <input
            type="checkbox"
            checked={lowOnly}
            onChange={(e) => setLowOnly(e.target.checked)}
            className="h-4 w-4 rounded border-border-strong text-primary focus:ring-2 focus:ring-primary-light"
          />
          Low stock only
        </label>
      </div>

      {isLoading ? (
        <TableSkeleton rows={6} columns={6} />
      ) : error ? (
        <ErrorState
          message={
            error instanceof ApiRequestError ? error.message : 'We could not load your stock.'
          }
          onRetry={() => refetch()}
        />
      ) : !data || data.items.length === 0 ? (
        <EmptyState
          title={filtered ? 'No matching items' : 'No stock items yet'}
          description={
            filtered
              ? 'No items match these filters. Try clearing them.'
              : 'Add an item to track what you hold and have it deducted when you invoice.'
          }
          action={
            !filtered && canWrite ? (
              <Link href="/stock/new">
                <Button>New item</Button>
              </Link>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-hidden rounded-md border border-border bg-surface shadow-card">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse">
              <caption className="sr-only">Stock items</caption>
              <thead>
                <tr className="border-b border-border bg-canvas">
                  {/* Labelled "Category" but still backed by the `sku` field —
                      a display rename, not a schema change. */}
                  <th scope="col" className="p-4 text-left text-body-sm font-semibold text-ink-secondary">
                    Category
                  </th>
                  <th scope="col" className="p-4 text-left text-body-sm font-semibold text-ink-secondary">
                    Item
                  </th>
                  <th scope="col" className="p-4 text-right text-body-sm font-semibold text-ink-secondary">
                    In stock
                  </th>
                  <th scope="col" className="p-4 text-right text-body-sm font-semibold text-ink-secondary">
                    Unit price
                  </th>
                  {canWrite && (
                    <th scope="col" className="p-4 text-right text-body-sm font-semibold text-ink-secondary">
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={item.id} className="border-b border-border last:border-b-0 hover:bg-canvas">
                    <td className="p-4 text-body text-ink-secondary">{item.sku}</td>
                    <td className="p-4">
                      <span className="text-body font-medium text-ink">{item.name}</span>
                      {!item.tracksStock && (
                        <span className="ml-2">
                          <Badge tone="gray">Not tracked</Badge>
                        </span>
                      )}
                    </td>
                    <td className="p-4 text-right text-body">
                      <span className={item.isLow ? 'font-medium text-danger' : 'text-ink'}>
                        {qty(item.quantityOnHand)} {item.unit}
                      </span>
                      {item.isLow && (
                        <AlertTriangle
                          className="ml-1 inline h-3.5 w-3.5 text-danger"
                          aria-label="Low stock"
                        />
                      )}
                    </td>
                    <td className="p-4 text-right text-body text-ink-secondary">
                      <Money amount={item.unitPrice} />
                    </td>
                    {canWrite && (
                      <td className="p-4 text-right">
                        <Button variant="secondary" onClick={() => setAdjusting(item)}>
                          Adjust
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {adjusting && (
        <AdjustModal
          item={adjusting}
          onClose={() => setAdjusting(null)}
          onDone={async () => {
            setAdjusting(null);
            await queryClient.invalidateQueries({ queryKey: ['stock'] });
          }}
        />
      )}
    </div>
  );
}

function AdjustModal({
  item,
  onClose,
  onDone,
}: {
  item: StockItem;
  onClose: () => void;
  onDone: () => void;
}) {
  const [movementType, setMovementType] = useState<'IN' | 'OUT' | 'ADJUSTMENT'>('IN');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit() {
    setError(null);
    if (!/^\d+(\.\d{1,4})?$/.test(quantity.trim())) {
      setError('Enter a quantity as a number');
      return;
    }
    setSaving(true);
    try {
      await apiFetch(`/stock/${item.id}/adjust`, {
        method: 'POST',
        json: { movementType, quantity: quantity.trim(), reason: reason.trim() || null },
      });
      onDone();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Adjust ${item.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} loading={saving}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-body-sm text-ink-muted">
          Currently {qty(item.quantityOnHand)} {item.unit} in stock. Every adjustment is recorded as
          a movement, so the history stays auditable.
        </p>

        {error && (
          <p role="alert" className="text-body-sm text-danger">
            {error}
          </p>
        )}

        <Field label="Type" htmlFor="movementType">
          <Select
            id="movementType"
            value={movementType}
            onChange={(e) => setMovementType(e.target.value as 'IN' | 'OUT' | 'ADJUSTMENT')}
          >
            <option value="IN">Stock received (add)</option>
            <option value="OUT">Stock removed (damage, write-off)</option>
            <option value="ADJUSTMENT">Set to counted total</option>
          </Select>
        </Field>

        <Field
          label={movementType === 'ADJUSTMENT' ? 'Counted total' : 'Quantity'}
          htmlFor="quantity"
          required
        >
          <Input
            id="quantity"
            inputMode="decimal"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </Field>

        <Field label="Reason" htmlFor="reason" hint="Optional, but useful when auditing later.">
          <Input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
