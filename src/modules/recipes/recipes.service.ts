import { BadRequestException, Injectable } from '@nestjs/common';
import type { ReplaceRecipeDto } from './dto/replace-recipe.dto';
import { RecipesRepository } from './recipes.repository';

@Injectable()
export class RecipesService {
  constructor(private readonly repository: RecipesRepository) {}

  get(productId: string) {
    return this.repository.findByProductId(productId);
  }

  create(productId: string, input: ReplaceRecipeDto) {
    return this.repository.create(productId, this.normalizeItems(input.items));
  }

  update(productId: string, input: ReplaceRecipeDto) {
    return this.repository.update(productId, this.normalizeItems(input.items));
  }

  private normalizeItems(items: ReplaceRecipeDto['items']) {
    const seen = new Set<string>();
    return items.map((item) => {
      if (seen.has(item.stock_item_id))
        throw new BadRequestException(
          'A stock item may appear only once in a recipe',
        );
      seen.add(item.stock_item_id);

      if (!/[1-9]/.test(item.quantity_required))
        throw new BadRequestException(
          'Recipe quantities must be greater than zero',
        );

      return {
        stock_item_id: item.stock_item_id,
        quantity_required: item.quantity_required,
      };
    });
  }
}
