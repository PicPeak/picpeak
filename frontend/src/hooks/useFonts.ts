import { useQuery } from '@tanstack/react-query';
import { fontsService, FONTS_QUERY_KEY, type FontDefinition } from '../services/fonts.service';

/**
 * The self-hosted font families a font picker offers, bundled and uploaded.
 * One query for every picker: an upload or removal invalidates its key
 * (FontsCard), so all of them follow.
 */
export function useFonts() {
  return useQuery<FontDefinition[]>({ queryKey: FONTS_QUERY_KEY, queryFn: () => fontsService.list(), staleTime: 5 * 60 * 1000 });
}
