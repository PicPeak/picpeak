import React from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useBookingsReachable } from './useBookingsReachable';

/**
 * Route guard for CRM → Bookings: like RequireFeature for `calendarBooking`,
 * but also open while deposits wait for a decision with the flag off.
 */
export const RequireBookings: React.FC = () => {
  const { reachable, isLoading } = useBookingsReachable();
  if (isLoading) return null;
  return reachable ? <Outlet /> : <Navigate to="/admin/dashboard" replace />;
};
