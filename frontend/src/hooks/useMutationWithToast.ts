import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryKey, UseMutationOptions, UseMutationResult } from '@tanstack/react-query';
import { toast } from 'react-toastify';

/**
 * Extracts the server-provided error message from an axios error response,
 * matching the `error.response?.data?.error` pattern used across admin pages.
 */
const extractServerError = (error: unknown): string | undefined => {
  const serverError = (error as { response?: { data?: { error?: unknown; message?: unknown } } })
    ?.response?.data;
  if (typeof serverError?.error === 'string') return serverError.error;
  if (typeof serverError?.message === 'string') return serverError.message;
  return undefined;
};

export interface UseMutationWithToastOptions<TData, TError, TVariables, TContext>
  extends UseMutationOptions<TData, TError, TVariables, TContext> {
  /** Toast shown on success. Omit to show no success toast. */
  successMessage?: string | ((data: TData, variables: TVariables) => string);
  /**
   * Fallback toast shown on error when the server response carries no error
   * message. Pass a function to take full control of the error text.
   */
  errorMessage?: string | ((error: TError) => string);
  /** Query keys invalidated on success, before the passthrough `onSuccess` runs. */
  invalidateKeys?: QueryKey[];
}

/**
 * `useMutation` wrapper for the common admin mutation shape:
 * invalidate queries + success toast on success, error toast (server message
 * first, then `errorMessage` fallback) on error. Passthrough `onSuccess` /
 * `onError` still run after the built-in handling.
 */
export function useMutationWithToast<
  TData = unknown,
  TError = Error,
  TVariables = void,
  TContext = unknown,
>(
  options: UseMutationWithToastOptions<TData, TError, TVariables, TContext>
): UseMutationResult<TData, TError, TVariables, TContext> {
  const queryClient = useQueryClient();
  const { successMessage, errorMessage, invalidateKeys, onSuccess, onError, ...mutationOptions } =
    options;

  return useMutation<TData, TError, TVariables, TContext>({
    ...mutationOptions,
    onSuccess: (data, variables, onMutateResult, context) => {
      invalidateKeys?.forEach((queryKey) => {
        queryClient.invalidateQueries({ queryKey });
      });
      if (successMessage) {
        toast.success(
          typeof successMessage === 'function' ? successMessage(data, variables) : successMessage
        );
      }
      onSuccess?.(data, variables, onMutateResult, context);
    },
    onError: (error, variables, onMutateResult, context) => {
      const message =
        typeof errorMessage === 'function'
          ? errorMessage(error)
          : extractServerError(error) ||
            errorMessage ||
            (error instanceof Error ? error.message : undefined) ||
            'An unexpected error occurred';
      toast.error(message);
      onError?.(error, variables, onMutateResult, context);
    },
  });
}
