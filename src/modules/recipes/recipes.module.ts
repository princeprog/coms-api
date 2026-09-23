import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RecipesController } from './recipes.controller';
import { RecipesRepository } from './recipes.repository';
import { RecipesService } from './recipes.service';

@Module({
  imports: [AuthModule],
  controllers: [RecipesController],
  providers: [RecipesRepository, RecipesService],
})
export class RecipesModule {}
